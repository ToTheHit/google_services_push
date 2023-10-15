/// <reference types="node" />
import { Credentials } from "google-auth-library/build/src/auth/credentials";
import { gmail_v1 } from "googleapis/build/src/apis/gmail/v1";
export interface IProps {
    clientId: string;
    clientSecret: string;
    pubSubTopic: string;
    prevHistoryGetter?: () => {};
    prevHistorySetter?: () => {};
    tokensHandler?: () => {};
}
export interface IPushPayload {
    message: {
        data: string;
        messageId: string;
        message_id: string;
        publishTime: string;
        publish_time: string;
    };
    subscription: string;
}
declare const VALID_HISTORY_TYPES: readonly ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"];
export type THistoryType = typeof VALID_HISTORY_TYPES[number];
export interface IMessageGetterOptions {
    pushPayload: IPushPayload;
    userCredentials: Credentials;
    withLabel: string[];
    withoutLabel?: string[];
    historyTypes: THistoryType[];
}
export interface IPrevHistory {
    emailAddress: string;
    prevHistoryId: number;
}
export interface IAttachment {
    mimeType: string;
    filename: string;
    attachmentId: string;
    size: number;
    data?: Buffer;
}
interface IEmailHeader {
    name: string;
    address: string;
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
export default class GmailServices {
    private _api;
    constructor(props: IProps);
    parsePushPayload(pushPayload: IPushPayload): any;
    setUserCredentials(userCredentials: Credentials): void;
    private _getHistoryId;
    private _initialize;
    private _getHistory;
    private _makeHistoryTypePlural;
    private _filterHistory;
    private _getMessageFromId;
    private _parseEmailAddressHeader;
    private _parsePayload;
    private _parseMessage;
    private _filterMessage;
    getMessagesWithoutAttaches(options: IMessageGetterOptions): Promise<IParsedMessage[]>;
    getAttachment(message: IParsedMessage, attachment: IAttachment): Promise<Buffer>;
    getMessages(options: IMessageGetterOptions): Promise<IParsedMessage[]>;
}
export {};
