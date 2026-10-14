// Reported phone structure with synthetic content instead of private chat text.
export const phoneWidget=`<div style="max-width: 340px; margin: 18px auto; background: #0b0c10; border-radius: 34px; padding: 12px; border: 3px solid #282a36; box-shadow: 0 20px 50px rgba(0,0,0,0.9), inset 0 0 2px rgba(255,255,255,0.2); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #f8fafc; position: relative;">
  <style>
    .kb-ph-notch { width: 100px; height: 22px; background: #000; border-radius: 14px; margin: 2px auto 12px; display: flex; align-items: center; justify-content: space-between; padding: 0 10px; }
    .kb-ph-card { background: rgba(30, 33, 45, 0.88); border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 10px 12px; margin-bottom: 8px; backdrop-filter: blur(12px); }
    .kb-ph-chk { display: none; }
    .kb-ph-expand { cursor: pointer; display: block; }
    .kb-ph-hidden { display: none; margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.1); font-size: 11px; color: #cbd5e1; }
    #kb-msg-exp:checked ~ .kb-ph-expand .kb-ph-hidden { display: block; }
  </style>
  <!-- Dynamic Island -->
  <div class="kb-ph-notch">
    <div style="width: 8px; height: 8px; border-radius: 50%; background: #1e293b; border: 1px solid #334155;"></div>
    <span style="font-size: 9px; color: #a855f7; font-family: monospace;">DND ACTIVE</span>
  </div>
  <div style="text-align: center; margin-bottom: 14px;">
    <div style="font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.08em;">Tuesday, August 12</div>
    <div style="font-size: 46px; font-weight: 800; line-height: 1.05; letter-spacing: -0.03em; color: #f1f5f9;">1:23</div>
  </div>
  <div class="kb-ph-card">
    <div style="display: flex; justify-content: space-between; font-size: 10px; color: #38bdf8; font-weight: 700; margin-bottom: 3px;">
      <span>TEST CONTACT • IMESSAGE</span><span style="color: #64748b; font-weight: 400;">now</span>
    </div>
    <div style="font-size: 12px; line-height: 1.35; color: #e2e8f0;">Synthetic notification content must not be read aloud.</div>
  </div>
  <input type="checkbox" id="kb-msg-exp" class="kb-ph-chk">
  <label for="kb-msg-exp" class="kb-ph-card kb-ph-expand">
    <div style="display: flex; justify-content: space-between; font-size: 10px; color: #facc15; font-weight: 700; margin-bottom: 3px;">
      <span>NOTES // LOCKED ENTRY (TAP TO PEEK)</span><span style="color: #64748b; font-weight: 400;">4:12 AM</span>
    </div>
    <div style="font-size: 11px; color: #94a3b8; font-style: italic;">"Synthetic preview must stay silent."</div>
    <div class="kb-ph-hidden"><div style="font-family: 'Courier New', monospace; line-height: 1.45; color: #f1f5f9;">Synthetic hidden note must also stay silent.</div></div>
  </label>
  <div style="width: 110px; height: 4px; background: #475569; border-radius: 2px; margin: 10px auto 2px;"></div>
</div>`;
