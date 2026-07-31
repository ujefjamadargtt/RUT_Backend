'use strict';

/**
 * Company Email API client (Techspool). MANDATORY, VERBATIM implementation
 * per explicit product requirement — do not alter the request contract
 * (URL path, header names, body field names), and do not replace `request`
 * with Nodemailer/axios/fetch/http(s). Callback-based on purpose; async
 * callers wrap this ONE function at their own call site (see
 * forgotPasswordService.js's sendEmailAsync) rather than converting this
 * file to return a Promise.
 */
exports.sendEmail = (to, subject, body, callback) => {
    var request = require('request');
    console.log("IN SEND EMAIL");

    var options = {
        url: process.env.GM_API + 'sendEmail',
        headers: {
            "apikey": process.env.GM_API_KEY,
            "supportkey": process.env.SUPPORT_KEY,
            "applicationkey": process.env.APPLICATION_KEY
        },
        body: {
            KEY: process.env.EMAIL_SERVER_KEY,
            TO: to,
            SUBJECT: subject,
            BODY: body
        },
        json: true
    }

    request.post(options, (error, response, body) => {
        if (error) {
            console.log("request error -send email ", error);
            callback("EMAIL SEND ERROR.");
        } else {
            console.log(body);
            callback(null, "EMAIL SEND", response);
        }
    });
}
  