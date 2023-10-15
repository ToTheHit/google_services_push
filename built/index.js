"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const googleapis_1 = require("googleapis");
const fs_1 = require("fs");
const VALID_HISTORY_TYPES = [
    'messageAdded',
    'messageDeleted',
    'labelAdded',
    'labelRemoved',
];
class GmailServices {
    constructor(props) {
        const auth = new googleapis_1.google.auth.OAuth2(props.clientId, props.clientSecret);
        this._api = {
            auth,
            gmail: googleapis_1.google.gmail({
                version: 'v1',
                auth
            }),
            prevHistoryHandler: async (email) => {
                let savedData;
                try {
                    savedData = JSON.parse(
                    // @ts-ignore
                    (await fs_1.promises.readFile('gmailpush_history.json')));
                }
                catch (e) {
                    if (e.code === 'ENOENT' && e.syscall === 'open') {
                        await fs_1.promises.writeFile('gmailpush_history.json', '[]');
                        return undefined;
                    }
                }
                console.log('>>> savedData', savedData);
                return savedData.find(({ emailAddress }) => emailAddress === email);
            },
            saveHistoryHandler: async (data) => {
                const savedData = JSON.parse(
                // @ts-ignore
                (await fs_1.promises.readFile('gmailpush_history.json')));
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
                await fs_1.promises.writeFile('gmailpush_history.json', JSON.stringify(savedData));
            }
        };
    }
    parsePushPayload(pushPayload) {
        return JSON.parse(Buffer.from(pushPayload.message.data, 'base64').toString());
    }
    setUserCredentials(userCredentials) {
        this._api.auth.setCredentials(userCredentials);
    }
    _getHistoryId(pushPayload) {
        return Number(this.parsePushPayload(pushPayload).historyId);
    }
    async _initialize(pushPayload, userCredentials) {
        console.log('>>>> PAYLOAD', this.parsePushPayload(pushPayload));
        this._api.email = this.parsePushPayload(pushPayload).emailAddress;
        let prevHistory = await this._api.prevHistoryHandler(this._api.email);
        if (!prevHistory) {
            prevHistory = {
                emailAddress: this._api.email,
                prevHistoryId: this._getHistoryId(pushPayload),
                // watchExpiration: null,
            };
        }
        if (this._getHistoryId(pushPayload) < prevHistory.prevHistoryId) {
            await this._api.saveHistoryHandler(prevHistory);
            return {
                shouldProceed: false
            };
        }
        const startHistoryId = prevHistory.prevHistoryId;
        prevHistory.prevHistoryId = this._getHistoryId(pushPayload);
        await this._api.saveHistoryHandler(prevHistory);
        return {
            shouldProceed: true,
            startHistoryId
        };
    }
    async _getHistory(startHistoryId, pageToken) {
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
        const options = {
            userId: this._api.email,
            startHistoryId: startHistoryId,
        };
        if (pageToken) {
            options.pageToken = pageToken;
        }
        const res = (await this._api.gmail.users.history.list(options)).data;
        console.log('%%%% res', res.history.length);
        const { nextPageToken, history } = res;
        // const {nextPageToken, history} = (
        //     await this._api.gmail.users.history.list(options)
        // ).data;
        // const nextPageToken = null;
        // history
        // console.log({nextPageToken, history});
        if (nextPageToken) {
            return [].concat(await this._getHistory(startHistoryId, nextPageToken));
        }
        return history || [];
    }
    _makeHistoryTypePlural(historyType) {
        return historyType.replace(/^message|label/, '$&s');
    }
    _filterHistory(history, historyTypes) {
        let filteredWithHistoryTypes = [];
        for (const historyType of historyTypes) {
            const pluralType = this._makeHistoryTypePlural(historyType);
            filteredWithHistoryTypes = filteredWithHistoryTypes.concat(history.filter(historyEntry => historyEntry.hasOwnProperty(pluralType)));
        }
        let filteredWithAddedRemovedLabelIds = [];
        filteredWithAddedRemovedLabelIds = filteredWithAddedRemovedLabelIds.concat(filteredWithHistoryTypes.filter((historyEntry) => {
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
        }));
        return filteredWithAddedRemovedLabelIds;
    }
    _getMessageFromId(messageId) {
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
    _parseEmailAddressHeader(emailAddressHeader) {
        const parsedHeader = emailAddressHeader.match(/(?:(.*)\s)?(?:<?(.+@[^>]+)>?)/);
        if (parsedHeader) {
            return {
                name: parsedHeader[1] || parsedHeader[2],
                address: parsedHeader[2],
            };
        }
        else {
            return {
                name: emailAddressHeader,
                address: emailAddressHeader,
            };
        }
    }
    _parsePayload(payload, parsedMessage) {
        if (payload.mimeType.startsWith('multipart/')) {
            for (const part of payload.parts) {
                this._parsePayload(part, parsedMessage);
            }
        }
        else if (payload.mimeType === 'text/html') {
            parsedMessage.bodyHtml = Buffer.from(payload.body.data, 'base64').toString();
        }
        else if (payload.mimeType === 'text/plain') {
            parsedMessage.bodyText = Buffer.from(payload.body.data, 'base64').toString();
        }
        else if (payload.mimeType.startsWith('image/') ||
            payload.mimeType.startsWith('audio/') ||
            payload.mimeType.startsWith('video/') ||
            payload.mimeType.startsWith('application/') ||
            payload.mimeType.startsWith('font/') ||
            payload.mimeType.startsWith('text/') ||
            payload.mimeType.startsWith('model/')) {
            parsedMessage.attachments.push({
                mimeType: payload.mimeType,
                filename: payload.filename,
                attachmentId: payload.body.attachmentId,
                size: payload.body.size,
            });
        }
    }
    _parseMessage(message, historyEntry) {
        const parsedMessage = Object.assign({
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
                .forEach((e) => parsedMessage.to.push(this._parseEmailAddressHeader(e)));
        }
        const cc = message.payload.headers.find((header) => header.name === 'Cc');
        if (cc) {
            parsedMessage.cc = [];
            cc.value
                .split(', ')
                .forEach((e) => parsedMessage.cc.push(this._parseEmailAddressHeader(e)));
        }
        const bcc = message.payload.headers.find((header) => header.name === 'Bcc');
        if (bcc) {
            parsedMessage.bcc = [];
            bcc.value
                .split(', ')
                .forEach((e) => parsedMessage.bcc.push(this._parseEmailAddressHeader(e)));
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
    _filterMessage(message, options) {
        var _a;
        const withLabelNormalized = {};
        const withoutLabelNormalized = {};
        options.withLabel.forEach(label => {
            withLabelNormalized[label] = true;
        });
        (_a = options.withoutLabel) === null || _a === void 0 ? void 0 : _a.forEach(label => {
            withoutLabelNormalized[label] = true;
        });
        options.withLabel.forEach(label => {
            if (withoutLabelNormalized[label]) {
                throw new Error('withLabel and withoutLabel should not have the same label');
            }
        });
        if (!message.labelIds || (message === null || message === void 0 ? void 0 : message.labelIds.length) === 0) {
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
    async getMessagesWithoutAttaches(options) {
        const { shouldProceed, startHistoryId } = await this._initialize(options.pushPayload, options.userCredentials);
        if (!shouldProceed) {
            return [];
        }
        const history = await this._getHistory(startHistoryId)
            .then((history) => this._filterHistory(history, options.historyTypes));
        if (!history.length) {
            return [];
        }
        const promises = [];
        history.forEach(historyEntry => {
            historyEntry.messages.forEach(message => {
                promises.push(this._getMessageFromId(message.id));
            });
        });
        let messages = await Promise.all(promises);
        messages.forEach((messageRaw, index) => {
            messages[index] = this._parseMessage(messageRaw, history[index]);
        });
        messages = messages.filter((message) => this._filterMessage(message, options));
        return messages;
    }
    async getAttachment(message, attachment) {
        const { data } = (await this._api.gmail.users.messages.attachments.get({
            id: attachment.attachmentId,
            messageId: message.id,
            userId: this._api.email,
        })).data;
        return Buffer.from(data, 'base64');
    }
    async getMessages(options) {
        const messages = await this.getMessagesWithoutAttaches(options);
        await Promise.all(messages.map((message) => Promise.all(message.attachments.map(async (attachment) => {
            attachment.data = await this.getAttachment(message, attachment);
        }))));
        return messages;
    }
}
exports.default = GmailServices;
const cred = {
    id: '1048430845408-kr6m9324rdatrjg9qsn9255kavmg27ki.apps.googleusercontent.com',
    secret: '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',
    callback: '/api/v1/user/auth/google/callback/web',
    pubsubTopic: 'projects/mybase-dev/topics/gmail',
    scope: [
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/user.birthday.read',
        'https://www.googleapis.com/auth/user.phonenumbers.read',
        'https://www.googleapis.com/auth/contacts',
        'https://mail.google.com'
    ].join(',')
};
// const body = {
//     message: {
//         data: '123'
//     }
// };
// const body = {
//     "message": {
//         "data": "eyJlbWFpbEFkZHJlc3MiOiJkbXRzaGt2QGdtYWlsLmNvbSIsImhpc3RvcnlJZCI6MTUwOTc2MX0=",
//         "messageId": "8080607222555870",
//         "message_id": "8080607222555870",
//         "publishTime": "2023-08-20T07:20:45.566Z",
//         "publish_time": "2023-08-20T07:20:45.566Z"
//     }, "subscription": "projects/mybase-dev/subscriptions/gmail-sub"
// }
// const gmailpush = new GmailServices({
//     clientId: cred.id,
//     clientSecret: cred.secret,
//     pubSubTopic: cred.pubsubTopic
// });
// const token = {
//     access_token: 'ya29.a0AfB_byBSd4hZLc9DlgF372IwNzsT9s3uKksY3qQBEGD8UPj0kJaQ-bWgj8KC48iAPlZNfnDDSavWCnayDFZBOtKhgYyWQiXfXi8SsqHvoTNAgeW9HtjEp-MsUBEX77YVxLeIOHR7yPNjgNr4tXcZAMsVTzVNaCgYKAWQSARASFQHsvYlsfpu8-AMjScViEB4jdjIB4A0163',
//     refresh_token: '1//0ceCzSrIT8MMjCgYIARAAGAwSNwF-L9IrW65qDEb_SIhloxJgjbx2JoNCcYKhX5tqScxin4aZ4mlBlqjxZZPV6Xvzi99WPH4OlQc',
//     scope: cred.scope
// };
// const main = async () => {
//     gmailpush.setUserCredentials(token);
//
//     const messages = await gmailpush.getMessages({
//         pushPayload: body,
//         userCredentials: token,
//         withLabel: ['INBOX'],
//         historyTypes: ['messageAdded']
//     });
//
// }
//
// main();
