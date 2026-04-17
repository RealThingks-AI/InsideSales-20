// Shared Microsoft Graph email sending utility
// Used by send-campaign-email, check-email-replies, and daily-action-reminders

export interface AzureEmailConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  senderEmail: string;
}

export interface SendEmailResult {
  success: boolean;
  error?: string;
  errorCode?: string;
  graphMessageId?: string;
  internetMessageId?: string;
  conversationId?: string;
}

export function getAzureEmailConfig(): AzureEmailConfig | null {
  const tenantId = Deno.env.get("AZURE_EMAIL_TENANT_ID") || Deno.env.get("AZURE_TENANT_ID");
  const clientId = Deno.env.get("AZURE_EMAIL_CLIENT_ID") || Deno.env.get("AZURE_CLIENT_ID");
  const clientSecret = Deno.env.get("AZURE_EMAIL_CLIENT_SECRET") || Deno.env.get("AZURE_CLIENT_SECRET");
  const senderEmail = Deno.env.get("AZURE_SENDER_EMAIL");

  if (!tenantId || !clientId || !clientSecret || !senderEmail) {
    return null;
  }

  return { tenantId, clientId, clientSecret, senderEmail };
}

export async function getGraphAccessToken(config: AzureEmailConfig): Promise<string> {
  const tokenUrl = `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`;
  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });

  const data = await resp.json();
  if (!data.access_token) {
    const errMsg = data.error_description || data.error || "Unknown token error";
    throw new Error(`Azure token error: ${errMsg}`);
  }
  return data.access_token;
}

/**
 * Two-step send: Create draft → send it.
 * This captures the Graph message ID, internetMessageId, and conversationId
 * which are needed for reply threading/tracking.
 */
export async function sendEmailViaGraph(
  accessToken: string,
  senderEmail: string,
  recipientEmail: string,
  recipientName: string,
  subject: string,
  htmlBody: string,
): Promise<SendEmailResult> {
  // Step 1: Create a draft message
  const createUrl = `https://graph.microsoft.com/v1.0/users/${senderEmail}/messages`;
  const messagePayload = {
    subject,
    body: { contentType: "HTML", content: htmlBody },
    toRecipients: [{ emailAddress: { address: recipientEmail, name: recipientName } }],
  };

  const createResp = await fetch(createUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(messagePayload),
  });

  if (!createResp.ok) {
    const errBody = await createResp.text();
    let errorCode = "DRAFT_FAILED";
    try {
      const parsed = JSON.parse(errBody);
      errorCode = parsed?.error?.code || "DRAFT_FAILED";
    } catch { /* ignore */ }
    console.error(`Graph create draft failed for ${recipientEmail}: ${createResp.status} ${errBody}`);
    return { success: false, error: errBody, errorCode };
  }

  const draftMessage = await createResp.json();
  const graphMessageId = draftMessage.id;
  const internetMessageId = draftMessage.internetMessageId || null;
  const conversationId = draftMessage.conversationId || null;

  console.log(`Draft created: graphId=${graphMessageId}, internetMsgId=${internetMessageId}, convId=${conversationId}`);

  // Step 2: Send the draft
  const sendUrl = `https://graph.microsoft.com/v1.0/users/${senderEmail}/messages/${graphMessageId}/send`;
  const sendResp = await fetch(sendUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: "null",
  });

  if (!sendResp.ok) {
    const errBody = await sendResp.text();
    let errorCode = "SEND_FAILED";
    try {
      const parsed = JSON.parse(errBody);
      errorCode = parsed?.error?.code || "SEND_FAILED";
    } catch { /* ignore */ }
    console.error(`Graph send draft failed for ${recipientEmail}: ${sendResp.status} ${errBody}`);
    return { success: false, error: errBody, errorCode, graphMessageId, internetMessageId, conversationId };
  }

  // Consume empty response body
  await sendResp.text();

  return {
    success: true,
    graphMessageId,
    internetMessageId,
    conversationId,
  };
}
