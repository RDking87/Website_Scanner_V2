"use strict";

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('Missing SUPABASE_URL');
  if (!key) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, { auth: { persistSession: false } });
}

async function insertProspectEvent(supabase, eventRow) {
  try {
    const { error } = await supabase.from('tradeconvert_prospect_events').insert(eventRow);
    if (error) throw error;
  } catch (err) {
    console.warn('tradeconvert_prospect_events insert failed:', err.message || err);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    return { statusCode: 500, body: 'Stripe webhook env vars are missing' };
  }

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const signature = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
    const stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    if (stripeEvent.type === 'checkout.session.completed') {
      const session = stripeEvent.data.object;
      const prospectId = session.metadata?.prospect_id || null;
      if (prospectId) {
        const supabase = getSupabase();
        const paymentStatus = 'deposit_paid';
        const nextAction = 'Review payment and create workspace';
        const notesEntry = JSON.stringify([{ meta: 'Stripe webhook', text: `Checkout completed (${session.id})`, ts: new Date().toISOString() }]);

        const { data: current } = await supabase
          .from('tradeconvert_prospects')
          .select('notes')
          .eq('id', prospectId)
          .maybeSingle();

        let mergedNotes = notesEntry;
        if (current?.notes) {
          try {
            const existing = Array.isArray(current.notes) ? current.notes : JSON.parse(current.notes);
            mergedNotes = JSON.stringify([...(Array.isArray(existing) ? existing : []), { meta: 'Stripe webhook', text: `Checkout completed (${session.id})`, ts: new Date().toISOString() }]);
          } catch {
            mergedNotes = JSON.stringify([{ meta: 'Imported note', text: String(current.notes) }, { meta: 'Stripe webhook', text: `Checkout completed (${session.id})`, ts: new Date().toISOString() }]);
          }
        }

        const { error } = await supabase
          .from('tradeconvert_prospects')
          .update({
            payment_status: paymentStatus,
            next_action: nextAction,
            stripe_session_id: session.id,
            latest_source: 'stripe_webhook',
            latest_intent: 'deposit_paid',
            last_submitted_at: new Date().toISOString(),
            notes: mergedNotes,
          })
          .eq('id', prospectId);

        if (error) throw error;

        await insertProspectEvent(supabase, {
          prospect_id: prospectId,
          event_type: 'checkout_completed',
          source: 'stripe_webhook',
          intent: 'deposit_paid',
          title: 'Deposit paid',
          payload: {
            stripe_session_id: session.id,
            amount_total: session.amount_total,
            currency: session.currency,
          },
        });
      }
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error('stripe-webhook failed:', err);
    return { statusCode: 400, body: `Webhook error: ${err.message}` };
  }
};
