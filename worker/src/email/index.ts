import { Context } from "hono";

import { getJsonSetting, normalizeAddressDomain } from "../utils";
import { sendMailToTelegram } from "../telegram_api";
import { auto_reply } from "./auto_reply";
import { isBlocked } from "./black_list";
import { triggerWebhook, triggerAnotherWorker, commonParseMail } from "../common";
import { check_if_junk_mail } from "./check_junk";
import { remove_attachment_if_need } from "./check_attachment";
import { extractEmailInfo } from "./ai_extract";
import { forwardEmail } from "./forward";
import { EmailRuleSettings } from "../models";
import { CONSTANTS } from "../constants";
import { storeRawMail } from "./storage";


async function email(message: ForwardableEmailMessage, env: Bindings, ctx: ExecutionContext) {
    const toAddress = normalizeAddressDomain(message.to);
    if (await isBlocked(message.from, env)) {
        message.setReject("Reject from address");
        console.log(`Reject message from ${message.from} to ${toAddress}`);
        return;
    }
    const rawEmail = await new Response(message.raw).text();
    const parsedEmailContext: ParsedEmailContext = {
        rawEmail: rawEmail
    };

    // check if junk mail
    try {
        const is_junk = await check_if_junk_mail(env, toAddress, parsedEmailContext, message.headers.get("Message-ID"));
        if (is_junk) {
            message.setReject("Junk mail");
            console.log(`Junk mail from ${message.from} to ${toAddress}`);
            return;
        }
    } catch (error) {
        console.error("check junk mail error", error);
    }

    // check if unknown address mail
    try {
        const emailRuleSettings = await getJsonSetting<EmailRuleSettings>(
            { env: env } as Context<HonoCustomType>, CONSTANTS.EMAIL_RULE_SETTINGS_KEY
        );
        if (emailRuleSettings?.blockReceiveUnknowAddressEmail) {
            const db_address_id = await env.DB.prepare(
                `SELECT id FROM address where name = ? `
            ).bind(toAddress).first("id");
            if (!db_address_id) {
                message.setReject("Unknown address");
                console.log(`Unknown address mail from ${message.from} to ${toAddress}`);
                return;
            }
        }
    } catch (error) {
        console.error("check unknown address mail error", error);
    }

    // remove attachment if configured or size > 2MB
    try {
        await remove_attachment_if_need(env, parsedEmailContext, message.from, toAddress, message.rawSize);
    } catch (error) {
        console.error("remove attachment error", error);
    }

    const message_id = message.headers.get("Message-ID");
    // save email
    const storedMailId = await storeRawMail(
        env, message.from, toAddress, message_id, parsedEmailContext.rawEmail
    ).then(({ success, meta }) => {
        if (!success) {
            message.setReject(`Failed save message to ${toAddress}`);
            console.error(`Failed save message from ${message.from} to ${toAddress}`);
        }
        return success ? meta.last_row_id : undefined;
    }).catch((error) => {
        console.error("save email error", error);
        return undefined;
    });

    // forward email
    await forwardEmail(message, env);

    // auto reply email
    await auto_reply(message, env, toAddress);

    // Run asynchronous side effects (AI extraction, Telegram, Webhook, RPC) via ctx.waitUntil
    const runSideEffects = async () => {
        let aiExtractResult: ExtractResult | null = null;
        try {
            aiExtractResult = await extractEmailInfo(parsedEmailContext, env, message_id, toAddress);
        } catch (error) {
            console.error("AI email content extraction error", error);
        }

        const tasks = [
            (async () => {
                try {
                    await sendMailToTelegram(
                        { env: env } as Context<HonoCustomType>,
                        toAddress, parsedEmailContext, message_id, aiExtractResult
                    );
                } catch (error) {
                    console.error("send mail to telegram error", error);
                }
            })(),
            (async () => {
                try {
                    await triggerWebhook(
                        { env: env } as Context<HonoCustomType>,
                        toAddress, parsedEmailContext, storedMailId, aiExtractResult
                    );
                } catch (error) {
                    console.error("send webhook error", error);
                }
            })(),
            (async () => {
                try {
                    const parsedEmail = await commonParseMail(parsedEmailContext);
                    const parsedText = parsedEmail?.text ?? "";
                    const rpcEmail: RPCEmailMessage = {
                        from: message.from,
                        to: toAddress,
                        rawEmail: rawEmail,
                        headers: message.headers
                    };
                    await triggerAnotherWorker({ env: env } as Context<HonoCustomType>, rpcEmail, parsedText);
                } catch (error) {
                    console.error("trigger another worker error", error);
                }
            })()
        ];

        await Promise.allSettled(tasks);
    };

    if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(runSideEffects());
    } else {
        await runSideEffects();
    }
}

export { email }
