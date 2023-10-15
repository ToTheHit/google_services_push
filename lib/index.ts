import {google} from "googleapis";
import {OAuth2Client} from "google-auth-library/build/src/auth/oauth2client";
import {Credentials} from "google-auth-library/build/src/auth/credentials";
import {APIEndpoint} from "googleapis-common";
import {promises as fs} from "fs";
import {gmail_v1} from "googleapis/build/src/apis/gmail/v1";

const defaultPrevHistoryHandler = async (email: string) => {
    let savedData: IPrevHistory[];
    try {
        savedData = JSON.parse(
            // @ts-ignore
            (await fs.readFile('gmailpush_history.json'))
        )
    } catch (e) {
        if (e.code === 'ENOENT' && e.syscall === 'open') {
            await fs.writeFile('gmailpush_history.json', '[]')
            return undefined;
        }
    }

    return savedData.find(({emailAddress}) => emailAddress === email);
}

const defaultSaveHistoryHandler = async (data: IPrevHistory) => {
    const savedData: IPrevHistory[] = JSON.parse(
        // @ts-ignore
        (await fs.readFile('gmailpush_history.json'))
    )

    let needUpsert = true;
    for (const history of savedData) {
        if (history.emailAddress === data.emailAddress) {
            needUpsert = false;
            history.prevHistoryId = data.prevHistoryId;
            break;
        }
    }
    if (needUpsert) {
        savedData.push(data);
    }

    await fs.writeFile(
        'gmailpush_history.json',
        JSON.stringify(savedData)
    );
}

export interface IPushPayload {
    message: {
        data: string,
        messageId: string,
        message_id: string,
        publishTime: string,
        publish_time: string
    },
    subscription: string
}

const VALID_HISTORY_TYPES = [
    'messageAdded',
    'messageDeleted',
    'labelAdded',
    'labelRemoved',
] as const;

export type THistoryType = typeof VALID_HISTORY_TYPES[number];

export interface IMessageGetterOptions {
    pushPayload: IPushPayload,
    userCredentials: Credentials,
    withLabel: string[];
    withoutLabel?: string[];
    historyTypes: THistoryType[];
}

export interface IPrevHistory {
    emailAddress: string,
    prevHistoryId: number
}

export interface IAttachment {
    mimeType: string;
    filename: string;
    attachmentId: string;
    size: number;
    data?: Buffer;
}

export interface IEmailHeader {
    name: string;
    address: string
}

export interface IParsedMessage extends gmail_v1.Schema$Message {
    historyType: string;
    from: IEmailHeader;
    to: IEmailHeader[];
    cc: IEmailHeader[];
    bcc: IEmailHeader[];
    subject: string | null;
    date: string | null;
    attachments: IAttachment[];
    bodyHtml: string | null;
    bodyText: string | null;
}

export interface IGmailServiceProps {
    clientId: string;
    clientSecret: string;
    pubSubTopic: string;
    prevHistoryHandler?: (email: string) => Promise<IPrevHistory>;
    saveHistoryHandler?: (data: IPrevHistory) => Promise<void>;
}

export default class GmailService {
    private _api: {
        auth: OAuth2Client,
        gmail: APIEndpoint,
        email?: string,
        prevHistoryHandler: (email: string) => Promise<IPrevHistory>,
        saveHistoryHandler: (data: IPrevHistory) => Promise<void> // TODO: add 'data' type
    };

    constructor(props: IGmailServiceProps) {
        const auth = new google.auth.OAuth2(props.clientId, props.clientSecret)

        this._api = {
            auth,
            gmail: google.gmail({
                version: 'v1',
                auth
            }),
            prevHistoryHandler: props.prevHistoryHandler || defaultPrevHistoryHandler,
            saveHistoryHandler: props.saveHistoryHandler || defaultSaveHistoryHandler
        };
    }

    parsePushPayload(pushPayload: IPushPayload) { // TODO: add answer type
        return JSON.parse(Buffer.from(pushPayload.message.data, 'base64').toString());
    }

    setUserCredentials(userCredentials: Credentials) {
        this._api.auth.setCredentials(userCredentials);
    }

    async getMessagesWithoutAttaches(options: IMessageGetterOptions): Promise<IParsedMessage[]> {
        const {shouldProceed, startHistoryId} = await this._initialize(
            options.pushPayload,
            options.userCredentials
        );

        if (!shouldProceed) {
            return [];
        }

        const history = await this._getHistory(startHistoryId)
            .then((history) => this._filterHistory(history, options.historyTypes));

        if (!history.length) {
            return []
        }

        const promises = [];

        history.forEach(historyEntry => {
            historyEntry.messages.forEach(message => {
                promises.push(this._getMessageFromId(message.id))
            })
        })

        let messages: IParsedMessage[] = await Promise.all(promises);

        messages.forEach((messageRaw, index) => {
            messages[index] = this._parseMessage(messageRaw, history[index])
        })

        messages = messages.filter((message) => this._filterMessage(message, options));

        return messages;
    }

    async getAttachment(message: IParsedMessage, attachment: IAttachment) {
        const {data} = (
            await this._api.gmail.users.messages.attachments.get({
                id: attachment.attachmentId,
                messageId: message.id,
                userId: this._api.email,
            })
        ).data;

        return Buffer.from(data, 'base64');
    }

    async getMessages(options: IMessageGetterOptions) {
        const messages = await this.getMessagesWithoutAttaches(options);

        await Promise.all(
            messages.map((message) =>
                Promise.all(
                    message.attachments.map(async (attachment) => {
                        attachment.data = await this.getAttachment(message, attachment);
                    })
                )
            )
        );

        return messages;
    }

    private _getHistoryId(pushPayload: IPushPayload) {
        return Number(this.parsePushPayload(pushPayload).historyId);
    }

    private async _initialize(pushPayload: IPushPayload, userCredentials: Credentials) {
        this._api.email = this.parsePushPayload(pushPayload).emailAddress;

        let prevHistory = await this._api.prevHistoryHandler(this._api.email);
        if (!prevHistory) {
            prevHistory = {
                emailAddress: this._api.email,
                prevHistoryId: this._getHistoryId(pushPayload),
                // watchExpiration: null,
            }
        }

        if (this._getHistoryId(pushPayload) < prevHistory.prevHistoryId) {
            await this._api.saveHistoryHandler(prevHistory)

            return {
                shouldProceed: false
            };
        }

        const startHistoryId = prevHistory.prevHistoryId;
        prevHistory.prevHistoryId = this._getHistoryId(pushPayload);

        await this._api.saveHistoryHandler(prevHistory)

        return {
            shouldProceed: true,
            startHistoryId
        }
    }

    private async _getHistory(startHistoryId: number, pageToken?: string) {
        // const data = {
        //     "history": [
        //         {
        //             "id": "1509763",
        //             "messages": [{"id": "18a11d272f0ddbbb", "threadId": "18a11d272f0ddbbb"}],
        //             "messagesAdded": [{
        //                 "message": {
        //                     "id": "18a11d272f0ddbbb",
        //                     "threadId": "18a11d272f0ddbbb",
        //                     "labelIds": ["UNREAD", "CATEGORY_PERSONAL", "INBOX"]
        //                 }
        //             }]
        //         }
        //     ],
        //     "historyId": "1509814"
        // }
        //
        // return data.history;

        interface IOptions {
            userId: string,
            startHistoryId: number,
            pageToken?: string
        }

        const options: IOptions = {
            userId: this._api.email,
            startHistoryId: startHistoryId,
        };

        if (pageToken) {
            options.pageToken = pageToken;
        }

        const res = (
            await this._api.gmail.users.history.list(options)
        ).data;

        const {nextPageToken, history} = res;

        if (nextPageToken) {
            return [].concat(await this._getHistory(startHistoryId, nextPageToken));
        }

        return history || [];
    }

    private _makeHistoryTypePlural(historyType: THistoryType) {
        return historyType.replace(/^message|label/, '$&s');
    }

    private _filterHistory(history, historyTypes: THistoryType[]) {
        let filteredWithHistoryTypes = [];
        for (const historyType of historyTypes) {
            const pluralType = this._makeHistoryTypePlural(historyType);
            filteredWithHistoryTypes = filteredWithHistoryTypes.concat(
                history.filter(historyEntry => historyEntry.hasOwnProperty(pluralType))
            );
        }

        let filteredWithAddedRemovedLabelIds = [];
        filteredWithAddedRemovedLabelIds = filteredWithAddedRemovedLabelIds.concat(
            filteredWithHistoryTypes.filter((historyEntry) => {
                // if (
                //     this._api.addedLabelIds &&
                //     historyEntry.hasOwnProperty('labelsAdded') &&
                //     historyEntry.labelsAdded.filter((labelAdded) => {
                //         for (const addedLabelId of this._api.addedLabelIds) {
                //             if (labelAdded.labelIds.includes(addedLabelId)) {
                //                 return true;
                //             }
                //         }
                //         return false;
                //     }).length === 0
                // ) {
                //     return false;
                // }

                // if (
                //     this._api.removedLabelIds &&
                //     historyEntry.hasOwnProperty('labelsRemoved') &&
                //     historyEntry.labelsRemoved.filter((labelRemoved) => {
                //         for (const removedLabelId of this._api.removedLabelIds) {
                //             if (labelRemoved.labelIds.includes(removedLabelId)) {
                //                 return true;
                //             }
                //         }
                //         return false;
                //     }).length === 0
                // ) {
                //     return false;
                // }
                return true;
            })
        );

        return filteredWithAddedRemovedLabelIds;
    }

    private _getMessageFromId(messageId: string): gmail_v1.Schema$Message {
        return this._api.gmail.users.messages
            .get({
                id: messageId,
                userId: this._api.email,
            })
            .then((result) => result.data)
            .catch((err) => {
                if (err.message === 'Not Found' || err.message === 'Requested entity was not found.') {
                    return {
                        // For identifying which message was not found
                        id: messageId,
                        // For this message object to be passed through getAttachment()
                        attachments: [],
                        // Normal messages don't have notFound property
                        notFound: true,
                    };
                }

                throw err;
            });
    }

    private _parseEmailAddressHeader(emailAddressHeader: string): IEmailHeader {
        const parsedHeader = emailAddressHeader.match(
            /(?:(.*)\s)?(?:<?(.+@[^>]+)>?)/
        );

        if (parsedHeader) {
            return {
                name: parsedHeader[1] || parsedHeader[2],
                address: parsedHeader[2],
            };
        } else {
            return {
                name: emailAddressHeader,
                address: emailAddressHeader,
            };
        }
    }

    private _parsePayload(payload: gmail_v1.Schema$MessagePart, parsedMessage: IParsedMessage) {
        if (payload.mimeType.startsWith('multipart/')) {
            for (const part of payload.parts) {
                this._parsePayload(part, parsedMessage);
            }
        } else if (payload.mimeType === 'text/html') {
            parsedMessage.bodyHtml = Buffer.from(payload.body.data, 'base64').toString();
        } else if (payload.mimeType === 'text/plain') {
            parsedMessage.bodyText = Buffer.from(payload.body.data, 'base64').toString();
        } else if (
            payload.mimeType.startsWith('image/') ||
            payload.mimeType.startsWith('audio/') ||
            payload.mimeType.startsWith('video/') ||
            payload.mimeType.startsWith('application/') ||
            payload.mimeType.startsWith('font/') ||
            payload.mimeType.startsWith('text/') ||
            payload.mimeType.startsWith('model/')
        ) {
            parsedMessage.attachments.push({
                mimeType: payload.mimeType,
                filename: payload.filename,
                attachmentId: payload.body.attachmentId,
                size: payload.body.size,
            });
        }
    }

    private _parseMessage(message: gmail_v1.Schema$Message, historyEntry) {
        const parsedMessage: IParsedMessage = Object.assign({
            historyType: '',
            from: null,
            to: [],
            cc: [],
            bcc: [],
            subject: null,
            date: null,
            attachments: [],
            bodyHtml: null,
            bodyText: null
        }, message);

        for (const historyType of VALID_HISTORY_TYPES) {
            if (historyEntry.hasOwnProperty(this._makeHistoryTypePlural(historyType))) {
                parsedMessage.historyType = historyType;
                break;
            }
        }

        if (!message.hasOwnProperty('payload')) {
            return parsedMessage;
        }

        const from = message.payload.headers.find(header => header.name === 'From');

        if (from) {
            parsedMessage.from = this._parseEmailAddressHeader(from.value);
        }

        const to = message.payload.headers.find(header => header.name === 'To');

        if (to) {
            parsedMessage.to = [];
            to.value
                .split(', ')
                .forEach((e) =>
                    parsedMessage.to.push(this._parseEmailAddressHeader(e))
                );
        }

        const cc = message.payload.headers.find((header) => header.name === 'Cc');

        if (cc) {
            parsedMessage.cc = [];
            cc.value
                .split(', ')
                .forEach((e) =>
                    parsedMessage.cc.push(this._parseEmailAddressHeader(e))
                );
        }

        const bcc = message.payload.headers.find((header) => header.name === 'Bcc');

        if (bcc) {
            parsedMessage.bcc = [];
            bcc.value
                .split(', ')
                .forEach((e) =>
                    parsedMessage.bcc.push(this._parseEmailAddressHeader(e))
                );
        }

        const subject = message.payload.headers.find(header => header.name === 'Subject');

        if (subject) {
            parsedMessage.subject = subject.value;
        }

        const date = message.payload.headers.find(header => header.name === 'Date');

        if (date) {
            parsedMessage.date = date.value;
        }

        this._parsePayload(message.payload, parsedMessage);

        return parsedMessage;
    }

    private _filterMessage(message: gmail_v1.Schema$Message, options: Pick<IMessageGetterOptions, 'withLabel' | 'withoutLabel'>) {
        const withLabelNormalized = {};
        const withoutLabelNormalized = {};

        options.withLabel.forEach(label => {
            withLabelNormalized[label] = true;
        })
        options.withoutLabel?.forEach(label => {
            withoutLabelNormalized[label] = true;
        })
        options.withLabel.forEach(label => {
            if (withoutLabelNormalized[label]) {
                throw new Error('withLabel and withoutLabel should not have the same label');
            }
        });

        if (!message.labelIds || message?.labelIds.length === 0) {
            return false;
        }

        for (const label of message.labelIds) {
            if (withoutLabelNormalized[label]) {
                return false;
            }
        }

        for (const label of message.labelIds) {
            if (withLabelNormalized[label]) {
                return true;
            }
        }

        return false;
    }
}
