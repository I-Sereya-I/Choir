// Synthetic UI structure; no private card or chat content belongs in fixtures.
export const speechPanel=`<div style="background: #121316; border: 2px solid #2a2d35; border-radius: 22px">
  <style>.kb-tab-content { display: none; } #kb-tab1:checked ~ .kb-content-wrap #kb-c1 { display: block; }</style>
  <div><span>5:45 PM</span><span>84%</span><svg><title>Battery icon</title></svg></div>
  <div class="kb-msg-toast"><strong>Inbox notification</strong><div>UI message that must not be spoken.</div></div>
  <div>example.test/browser-interface</div>
  <input type="radio" name="kb-tabs" id="kb-tab1" checked>
  <input type="radio" name="kb-tabs" id="kb-tab2">
  <input type="radio" name="kb-tabs" id="kb-tab3">
  <div class="kb-tab-bar"><label for="kb-tab1">First tab</label><label for="kb-tab2">Second tab</label><label for="kb-tab3">Third tab</label></div>
  <div class="kb-content-wrap">
    <div id="kb-c1" class="kb-tab-content"><p>First panel content.</p></div>
    <div id="kb-c2" class="kb-tab-content"><div>Second panel content.</div></div>
    <div id="kb-c3" class="kb-tab-content"><p>Third panel content.</p></div>
  </div>
</div>`;
