(() => {
  const waitForApp = () => typeof state !== 'undefined' && typeof qs === 'function' && typeof renderBadges === 'function';

  function notificationCountEl() {
    const button = document.querySelector('#notificationButton');
    if (!button) return null;
    let count = document.querySelector('#notificationCount');
    if (!count) {
      count = document.createElement('span');
      count.id = 'notificationCount';
      count.className = 'notification-count';
      count.hidden = true;
      button.appendChild(count);
    }
    return count;
  }

  function communicationSummary() {
    const el = document.querySelector('#conversationContact');
    if (!el) return;
    const conversation = state.conversations.find(c => c.id === state.selectedConversationId);
    if (!conversation) return;
    const lead = state.leads.find(l => l.id === conversation.leadId);
    let note = el.querySelector('.v17-customer-note');
    if (!note) {
      note = document.createElement('div');
      note.className = 'v17-customer-note';
      el.appendChild(note);
    }

    const smsLive = !!state.integrations?.twilio && !!lead?.phone;
    const emailLive = !!state.integrations?.resend && !!lead?.email;
    if (smsLive) {
      note.innerHTML = '<strong>Two-way texting is live.</strong><span>Your customer replies from their normal phone. They never need a SiteRemade account.</span>';
    } else if (emailLive) {
      note.innerHTML = '<strong>Email delivery is live.</strong><span>Messages can reach this customer by email. Connect Twilio for true two-way texting inside this inbox.</span>';
    } else {
      note.innerHTML = '<strong>Off-site replies are not connected yet.</strong><span>Connect Twilio or Resend in Settings so customers do not have to return to website chat.</span>';
    }

    const send = document.querySelector('#messageForm button');
    if (send && !send.disabled) send.textContent = smsLive ? 'Send reply ↗' : emailLive ? 'Send email ↗' : 'Send chat reply ↗';
  }

  function drawerCommunication() {
    if (!state.selectedLeadId) return;
    const lead = state.leads.find(l => l.id === state.selectedLeadId);
    const form = document.querySelector('#leadDetailForm');
    if (!lead || !form) return;
    let bar = form.querySelector('.v17-lead-actions');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'v17-lead-actions';
      const first = form.firstElementChild;
      form.insertBefore(bar, first || null);
    }
    const conversation = state.conversations.find(c => c.leadId === lead.id);
    const unread = Number(conversation?.unread || 0);
    bar.innerHTML = `${lead.phone ? `<a href="tel:${esc(lead.phone)}">Call</a><a href="sms:${esc(lead.phone)}">Text</a>` : ''}${lead.email ? `<a href="mailto:${esc(lead.email)}">Email</a>` : ''}<button type="button" data-v17-open-inbox="${lead.id}">${conversation ? `Open conversation${unread ? ` · ${unread} unread` : ''}` : 'Start conversation'}</button>`;
    const open = bar.querySelector('[data-v17-open-inbox]');
    if (open) open.onclick = async () => {
      let c = state.conversations.find(x => x.leadId === lead.id);
      if (!c) {
        try {
          const d = await api('/api/app/conversations', { method: 'POST', body: JSON.stringify({ leadId: lead.id }) });
          c = d.conversation;
          await refreshLight();
        } catch (e) {
          alert(e.message);
          return;
        }
      }
      state.selectedConversationId = c.id;
      document.querySelector('#leadDrawer').hidden = true;
      switchView('inbox');
      renderInbox();
    };
  }

  function install() {
    if (!waitForApp()) return setTimeout(install, 80);
    notificationCountEl();

    const originalRenderBadges = renderBadges;
    renderBadges = function v17RenderBadges() {
      const counts = originalRenderBadges();
      const total = counts?.total || 0;
      const count = notificationCountEl();
      if (count) {
        count.textContent = total > 99 ? '99+' : String(total);
        count.hidden = !total;
      }
      const leadNav = document.querySelector('[data-view="leads"]');
      const inboxNav = document.querySelector('[data-view="inbox"]');
      if (leadNav) leadNav.title = counts?.newLeads ? `${counts.newLeads} new lead${counts.newLeads === 1 ? '' : 's'}` : 'Leads';
      if (inboxNav) inboxNav.title = counts?.unread ? `${counts.unread} unread customer message${counts.unread === 1 ? '' : 's'}` : 'Inbox';
      document.title = total ? `(${total}) SiteRemade — Client App` : 'SiteRemade — Client App';
      return counts;
    };

    const originalConversationWindow = renderConversationWindow;
    renderConversationWindow = function v17ConversationWindow() {
      const result = originalConversationWindow();
      communicationSummary();
      return result;
    };

    const originalPopulateDrawer = populateDrawer;
    populateDrawer = function v17PopulateDrawer(lead) {
      const result = originalPopulateDrawer(lead);
      drawerCommunication();
      return result;
    };

    const inboxView = document.querySelector('#view-inbox .page-head, #view-inbox');
    if (inboxView && !document.querySelector('#v17InboxExplainer')) {
      const explainer = document.createElement('div');
      explainer.id = 'v17InboxExplainer';
      explainer.className = 'v17-inbox-explainer';
      explainer.innerHTML = '<strong>Your customer does not use SiteRemade.</strong><span>You work from this inbox. Customers answer through their normal phone/email channels.</span>';
      inboxView.insertAdjacentElement('afterend', explainer);
    }

    renderBadges();
    if (state.selectedConversationId) communicationSummary();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
