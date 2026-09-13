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

  function conversationHasHistory(conversation) {
    return !!conversation && Array.isArray(conversation.messages) && conversation.messages.length > 0;
  }

  function deliveryForLead(lead) {
    return {
      sms: !!state.integrations?.twilio && !!lead?.phone,
      email: !!state.integrations?.resend && !!lead?.email,
      phone: !!lead?.phone,
      hasEmail: !!lead?.email
    };
  }

  function communicationSummary() {
    const el = document.querySelector('#conversationContact');
    if (!el) return;
    const conversation = state.conversations.find(c => c.id === state.selectedConversationId);
    if (!conversation) return;
    const lead = state.leads.find(l => l.id === conversation.leadId);
    const channels = deliveryForLead(lead);
    let note = el.querySelector('.v17-customer-note');
    if (!note) {
      note = document.createElement('div');
      note.className = 'v17-customer-note';
      el.appendChild(note);
    }

    if (channels.sms) {
      note.innerHTML = '<strong>Two-way text thread.</strong><span>You reply here. The customer replies from their normal phone and their response comes back into this inbox.</span>';
    } else if (channels.email) {
      note.innerHTML = '<strong>Email sending is available.</strong><span>Outbound email can be sent, but email replies are not treated as a SiteRemade inbox thread yet. Use the Email action for normal email conversations.</span>';
    } else {
      note.innerHTML = '<strong>This thread is website-only right now.</strong><span>The customer does not need SiteRemade. Connect SMS for a true off-site two-way inbox, or use Call / Text / Email from the customer record.</span>';
    }

    const send = document.querySelector('#messageForm button');
    if (send && !send.disabled) send.textContent = channels.sms ? 'Send text ↗' : channels.email ? 'Send message ↗' : 'Reply to website chat ↗';
  }

  function openLeadInbox(lead) {
    const conversation = state.conversations.find(c => c.leadId === lead.id && conversationHasHistory(c));
    if (conversation) {
      state.selectedConversationId = conversation.id;
      document.querySelector('#leadDrawer').hidden = true;
      switchView('inbox');
      renderInbox();
      return true;
    }
    return false;
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

    const conversation = state.conversations.find(c => c.leadId === lead.id && conversationHasHistory(c));
    const unread = Number(conversation?.unread || 0);
    const channels = deliveryForLead(lead);
    const inboxAction = conversation
      ? `<button type="button" data-v17-open-inbox="${lead.id}">Inbox${unread ? ` · ${unread} unread` : ''}</button>`
      : channels.sms
        ? `<button type="button" data-v17-start-sms="${lead.id}">Message in SiteRemade</button>`
        : '';

    bar.innerHTML = `${lead.phone ? `<a href="tel:${esc(lead.phone)}">Call</a><a href="sms:${esc(lead.phone)}">Text</a>` : ''}${lead.email ? `<a href="mailto:${esc(lead.email)}">Email</a>` : ''}${inboxAction}`;

    const open = bar.querySelector('[data-v17-open-inbox]');
    if (open) open.onclick = () => openLeadInbox(lead);

    const start = bar.querySelector('[data-v17-start-sms]');
    if (start) start.onclick = async () => {
      try {
        let c = state.conversations.find(x => x.leadId === lead.id);
        if (!c) {
          const d = await api('/api/app/conversations', { method: 'POST', body: JSON.stringify({ leadId: lead.id }) });
          c = d.conversation;
          await refreshLight();
        }
        state.selectedConversationId = c.id;
        document.querySelector('#leadDrawer').hidden = true;
        switchView('inbox');
        renderInbox();
        setTimeout(() => document.querySelector('#messageInput')?.focus(), 80);
      } catch (e) {
        alert(e.message);
      }
    };
  }

  function installInboxRules() {
    const originalRenderInbox = renderInbox;
    renderInbox = function v17RenderInbox() {
      const all = state.conversations;
      const real = all.filter(conversationHasHistory);
      if (state.selectedConversationId && !real.some(c => c.id === state.selectedConversationId)) {
        state.selectedConversationId = real[0]?.id || null;
      }
      if (!state.selectedConversationId && real[0]) state.selectedConversationId = real[0].id;
      state.conversations = real;
      try {
        return originalRenderInbox();
      } finally {
        state.conversations = all;
      }
    };

    const oldMessageLead = document.querySelector('#messageLeadButton');
    if (oldMessageLead) {
      oldMessageLead.textContent = 'Message customer';
      oldMessageLead.onclick = async () => {
        const lead = state.leads.find(l => l.id === state.selectedLeadId);
        if (!lead) return;
        if (openLeadInbox(lead)) return;
        const channels = deliveryForLead(lead);
        if (channels.sms) {
          try {
            let c = state.conversations.find(x => x.leadId === lead.id);
            if (!c) {
              const d = await api('/api/app/conversations', { method: 'POST', body: JSON.stringify({ leadId: lead.id }) });
              c = d.conversation;
              await refreshLight();
            }
            state.selectedConversationId = c.id;
            document.querySelector('#leadDrawer').hidden = true;
            switchView('inbox');
            renderConversationWindow();
            setTimeout(() => document.querySelector('#messageInput')?.focus(), 80);
          } catch (e) {
            alert(e.message);
          }
          return;
        }
        if (lead.phone) {
          location.href = `sms:${lead.phone}`;
          return;
        }
        if (lead.email) location.href = `mailto:${lead.email}`;
      };
    }

    const newConversation = document.querySelector('#newConversationButton');
    if (newConversation) {
      newConversation.textContent = 'New message';
      newConversation.title = 'Start a real customer message. SiteRemade inbox threads are not created just for empty CRM records.';
    }
  }

  function applyCalendarLeadStatus() {
    document.querySelectorAll('[data-appt]').forEach(button => {
      const appointment = state.appointments.find(a => a.id === button.dataset.appt);
      const lead = appointment?.leadId ? state.leads.find(l => l.id === appointment.leadId) : null;
      ['New', 'Contacted', 'Quoted', 'Won', 'Lost'].forEach(status => button.classList.remove(`lead-status-${status.toLowerCase()}`));
      if (lead?.status) {
        button.classList.add(`lead-status-${String(lead.status).toLowerCase()}`);
        button.dataset.leadStatus = lead.status;
        button.title = `${lead.name || appointment.customer || 'Customer'} · ${lead.status}`;
      }
    });
  }

  function installCalendarStatus() {
    const originalRenderCalendar = renderCalendar;
    renderCalendar = function v17RenderCalendar() {
      const result = originalRenderCalendar();
      applyCalendarLeadStatus();
      return result;
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

    installInboxRules();
    installCalendarStatus();

    const inboxView = document.querySelector('#view-inbox .page-head, #view-inbox');
    if (inboxView && !document.querySelector('#v17InboxExplainer')) {
      const explainer = document.createElement('div');
      explainer.id = 'v17InboxExplainer';
      explainer.className = 'v17-inbox-explainer';
      explainer.innerHTML = '<strong>Inbox is real communication history.</strong><span>Customers never log into SiteRemade. Website messages and connected SMS threads appear here; Call / Text / Email still use the customer contact details directly.</span>';
      inboxView.insertAdjacentElement('afterend', explainer);
    }

    renderBadges();
    renderInbox();
    renderCalendar();
    if (state.selectedConversationId) communicationSummary();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
