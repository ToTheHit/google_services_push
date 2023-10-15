import GmailService from "./lib";

const serviceCredentials = {
    id: 'XXXX.apps.googleusercontent.com',
    secret: 'xxxxxx-xxxxx-xxx_xxxxxxxxxxxxxxxxxx',
    pubsubTopic: 'Topic name',
    scope: [
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/user.birthday.read',
        'https://www.googleapis.com/auth/user.phonenumbers.read',
        'https://www.googleapis.com/auth/contacts',
        'https://mail.google.com'
    ].join(',')
};

const userCredentials = {
    access_token: 'user access token',
    refresh_token: 'user refresh token',
    scope: serviceCredentials.scope
};

const pushBody = {
    "message": {
        "data": "base64string",
        "messageId": "8080607222555870",
        "message_id": "8080607222555870",
        "publishTime": "2023-08-20T07:20:45.566Z",
        "publish_time": "2023-08-20T07:20:45.566Z"
    },
    "subscription": "Subscription name"
}

const main = async () => {
    const gmailService = new GmailService({
        clientId: serviceCredentials.id,
        clientSecret: serviceCredentials.secret,
        pubSubTopic: serviceCredentials.pubsubTopic
    });

    gmailService.setUserCredentials(userCredentials);

    const messages = await gmailService.getMessages({
        pushPayload: pushBody,
        userCredentials: userCredentials,
        withLabel: ['INBOX'],
        historyTypes: ['messageAdded']
    });

    console.log(messages);
}

main();
