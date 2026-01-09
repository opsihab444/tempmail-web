import PostalMime from 'postal-mime';

function inboxFromTo(to) {
    const local = (to.split("@")[0] || "").trim().toLowerCase();
    const parts = local.split("+");
    return parts.length > 1 ? parts[1] : local;
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "content-type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type"
        },
    });
}

export default {
    async email(message, env, ctx) {
        let textBody = "";
        let htmlBody = "";
        let subject = message.headers.get("subject") || "(no subject)";

        try {
            // Parse the raw email content
            const parser = new PostalMime();
            const email = await parser.parse(message.raw);

            textBody = email.text || "";
            htmlBody = email.html || "";
            if (email.subject) subject = email.subject;

            console.log(`Parsed email for ${message.to}: TextLen=${textBody.length}, HtmlLen=${htmlBody.length}`);

        } catch (e) {
            console.error("Failed to parse email:", e);
            textBody = "(Error parsing email body)";
        }

        const inbox = inboxFromTo(message.to);
        const id = crypto.randomUUID();
        const receivedAt = Date.now();

        // Insert with ACTUAL body content
        await env.DB.prepare(
            `INSERT INTO inbox_messages (id, inbox, mail_from, mail_to, subject, received_at, text, html)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(id, inbox, message.from, message.to, subject, receivedAt, textBody, htmlBody).run();
    },

    async fetch(request, env) {
        // Handle CORS
        if (request.method === "OPTIONS") {
            return new Response(null, {
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type",
                }
            });
        }

        const url = new URL(request.url);

        // Match: /api/inbox/:slug
        const inboxMatch = url.pathname.match(/^\/api\/inbox\/([a-z0-9_-]+)$/i);
        if (request.method === "GET" && inboxMatch) {
            const inbox = inboxMatch[1].toLowerCase();
            const { results } = await env.DB.prepare(
                `SELECT id, mail_from, subject, received_at
         FROM inbox_messages
         WHERE inbox = ?
         ORDER BY received_at DESC
         LIMIT 50`
            ).bind(inbox).all();
            return json({ ok: true, inbox, messages: results || [] });
        }

        // Match: /api/message/:uuid
        const msgMatch = url.pathname.match(/^\/api\/message\/([0-9a-f-]{36})$/i);
        if (request.method === "GET" && msgMatch) {
            const id = msgMatch[1];
            const row = await env.DB.prepare(
                `SELECT * FROM inbox_messages WHERE id = ?`
            ).bind(id).first();

            if (!row) return json({ ok: false, error: "not_found" }, 404);
            return json({ ok: true, message: row });
        }

        return json({ ok: true, message: "TempMail Worker Active" });
    },
};
