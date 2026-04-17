import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getAzureEmailConfig, getGraphAccessToken } from "../_shared/azure-email.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || Deno.env.get("MY_SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("MY_SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    const azureConfig = getAzureEmailConfig();
    if (!azureConfig) {
      return new Response(JSON.stringify({ error: "Azure email not configured" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let accessToken: string;
    try {
      accessToken = await getGraphAccessToken(azureConfig);
    } catch (err) {
      console.error("Failed to get Graph token for reply check:", (err as Error).message);
      return new Response(JSON.stringify({ error: "Auth failed" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Find sent emails from the last 7 days with a conversation_id
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: sentEmails, error: fetchErr } = await supabase
      .from("campaign_communications")
      .select("id, campaign_id, contact_id, account_id, conversation_id, internet_message_id, subject, owner, created_by")
      .eq("communication_type", "Email")
      .eq("sent_via", "azure")
      .not("conversation_id", "is", null)
      .gte("communication_date", sevenDaysAgo)
      .order("communication_date", { ascending: false });

    if (fetchErr) {
      console.error("Failed to fetch sent emails:", fetchErr);
      return new Response(JSON.stringify({ error: fetchErr.message }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!sentEmails || sentEmails.length === 0) {
      return new Response(JSON.stringify({ message: "No trackable emails found", repliesFound: 0 }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Group by conversation_id to avoid duplicate checks
    const conversationMap = new Map<string, typeof sentEmails>();
    for (const email of sentEmails) {
      const convId = email.conversation_id!;
      if (!conversationMap.has(convId)) {
        conversationMap.set(convId, []);
      }
      conversationMap.get(convId)!.push(email);
    }

    // Get all known internet_message_ids to skip already-tracked messages
    const allInternetMsgIds = new Set(
      sentEmails.map(e => e.internet_message_id).filter(Boolean)
    );

    // Also get all existing synced replies to avoid re-inserting
    const { data: existingSynced } = await supabase
      .from("campaign_communications")
      .select("internet_message_id")
      .eq("sent_via", "graph-sync")
      .not("internet_message_id", "is", null);

    const existingSyncedIds = new Set(
      (existingSynced || []).map(e => e.internet_message_id).filter(Boolean)
    );

    let totalRepliesFound = 0;
    const processedConversations: string[] = [];

    // Get unique sender emails to check their inboxes
    const senderEmails = new Set<string>();
    // We need profiles to map owner UUIDs to emails
    const ownerIds = [...new Set(sentEmails.map(e => e.owner || e.created_by).filter(Boolean))];
    const { data: profiles } = await supabase
      .from("profiles")
      .select('id, "Email ID"')
      .in("id", ownerIds);

    const ownerEmailMap = new Map<string, string>();
    for (const p of profiles || []) {
      if (p["Email ID"]) {
        ownerEmailMap.set(p.id, p["Email ID"]);
        senderEmails.add(p["Email ID"]);
      }
    }

    // Also add the shared mailbox
    senderEmails.add(azureConfig.senderEmail);

    for (const [convId, emails] of conversationMap.entries()) {
      // Determine which mailbox to check
      const primaryEmail = emails[0];
      const ownerId = primaryEmail.owner || primaryEmail.created_by;
      const senderEmail = ownerEmailMap.get(ownerId || "") || azureConfig.senderEmail;

      try {
        // Query Graph for messages in this conversation from the inbox
        const filter = encodeURIComponent(`conversationId eq '${convId}'`);
        const graphUrl = `https://graph.microsoft.com/v1.0/users/${senderEmail}/mailFolders/inbox/messages?$filter=${filter}&$orderby=receivedDateTime desc&$top=20&$select=id,subject,from,receivedDateTime,internetMessageId,conversationId,bodyPreview`;

        const graphResp = await fetch(graphUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!graphResp.ok) {
          const errText = await graphResp.text();
          console.error(`Graph inbox query failed for ${senderEmail}, conv ${convId}: ${graphResp.status} ${errText}`);
          continue;
        }

        const graphData = await graphResp.json();
        const inboxMessages = graphData.value || [];

        for (const msg of inboxMessages) {
          const msgInternetId = msg.internetMessageId;

          // Skip if we already know about this message
          if (!msgInternetId) continue;
          if (allInternetMsgIds.has(msgInternetId)) continue;
          if (existingSyncedIds.has(msgInternetId)) continue;

          // This is a new reply! Insert it as a campaign communication
          const fromEmail = msg.from?.emailAddress?.address || "";
          const fromName = msg.from?.emailAddress?.name || fromEmail;
          const receivedAt = msg.receivedDateTime || new Date().toISOString();

          // Find the original email this reply is associated with
          const originalEmail = emails[0]; // Use the first (most recent) sent email in this conversation

          const { error: insertErr } = await supabase
            .from("campaign_communications")
            .insert({
              campaign_id: originalEmail.campaign_id,
              contact_id: originalEmail.contact_id,
              account_id: originalEmail.account_id || null,
              communication_type: "Email",
              subject: msg.subject || `Re: ${originalEmail.subject || ""}`,
              body: msg.bodyPreview || null,
              email_status: "Replied",
              delivery_status: "received",
              sent_via: "graph-sync",
              internet_message_id: msgInternetId,
              conversation_id: convId,
              parent_id: originalEmail.id,
              owner: originalEmail.owner,
              created_by: originalEmail.created_by,
              notes: `Auto-synced reply from ${fromName} (${fromEmail})`,
              communication_date: receivedAt,
            });

          if (insertErr) {
            console.error(`Failed to insert reply for conv ${convId}:`, insertErr);
            continue;
          }

          totalRepliesFound++;
          existingSyncedIds.add(msgInternetId);

          // Update original email's status to "Replied"
          await supabase
            .from("campaign_communications")
            .update({ email_status: "Replied" })
            .eq("id", originalEmail.id);

          // Update email_history reply fields
          if (originalEmail.internet_message_id) {
            await supabase
              .from("email_history")
              .update({
                replied_at: receivedAt,
                last_reply_at: receivedAt,
                reply_count: 1, // Will be incremented properly if multiple replies
              })
              .eq("internet_message_id", originalEmail.internet_message_id);
          }

          // Update campaign_contacts stage to "Responded" if rank is higher
          if (originalEmail.contact_id) {
            const { data: cc } = await supabase
              .from("campaign_contacts")
              .select("stage")
              .eq("campaign_id", originalEmail.campaign_id)
              .eq("contact_id", originalEmail.contact_id)
              .single();

            const stageRanks: Record<string, number> = {
              "Not Contacted": 0, "Email Sent": 1, "Phone Contacted": 2,
              "LinkedIn Contacted": 3, "Responded": 4, "Qualified": 5,
            };
            const currentRank = stageRanks[cc?.stage || "Not Contacted"] ?? 0;
            if (stageRanks["Responded"] > currentRank) {
              await supabase
                .from("campaign_contacts")
                .update({ stage: "Responded" })
                .eq("campaign_id", originalEmail.campaign_id)
                .eq("contact_id", originalEmail.contact_id);
            }
          }

          // Recompute account status
          if (originalEmail.account_id) {
            const { data: acContacts } = await supabase
              .from("campaign_contacts")
              .select("stage")
              .eq("campaign_id", originalEmail.campaign_id)
              .eq("account_id", originalEmail.account_id);

            let derivedStatus = "Not Contacted";
            const contacts = acContacts || [];
            if (contacts.some((c: any) => c.stage === "Qualified")) derivedStatus = "Deal Created";
            else if (contacts.some((c: any) => c.stage === "Responded")) derivedStatus = "Responded";
            else if (contacts.some((c: any) => c.stage !== "Not Contacted")) derivedStatus = "Contacted";

            await supabase
              .from("campaign_accounts")
              .update({ status: derivedStatus })
              .eq("campaign_id", originalEmail.campaign_id)
              .eq("account_id", originalEmail.account_id);
          }
        }

        processedConversations.push(convId);
      } catch (convErr) {
        console.error(`Error processing conversation ${convId}:`, convErr);
      }
    }

    console.log(`Reply check complete: ${totalRepliesFound} new replies found across ${processedConversations.length} conversations`);

    return new Response(JSON.stringify({
      message: "Reply check complete",
      repliesFound: totalRepliesFound,
      conversationsChecked: processedConversations.length,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("Unexpected error in check-email-replies:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
