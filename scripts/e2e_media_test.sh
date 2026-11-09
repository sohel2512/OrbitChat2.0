#!/usr/bin/env bash
# E2E test: WhatsApp-style photo confirm sheet + sealed (E2E-encrypted) photos
set -u
cd /home/z/my-project
mkdir -p /tmp/shots
AB="agent-browser"

# 1) boot dev if not running
code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:3000/ 2>/dev/null || echo 000)
if [ "$code" != "200" ]; then
  nohup bun run dev >/tmp/dev-restart.log 2>&1 &
  for i in $(seq 1 120); do
    code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/ 2>/dev/null)
    [ "$code" = "200" ] && { echo "dev up (${i}s)"; break; }
    sleep 1
  done
  [ "$code" = "200" ] || { echo "DEV FAILED"; tail -30 /tmp/dev-restart.log; exit 1; }
fi
echo "rt: $(curl -s http://127.0.0.1:3000/api/rt)"

JOIN='(async()=>{const s=(el,v)=>{const d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),"value");d.set.call(el,v);el.dispatchEvent(new Event("input",{bubbles:true}))};const i=document.querySelectorAll(".oc-field input");s(i[0],"@@NAME@@");s(i[1],"10.0.0.7");document.querySelector(".oc-connect").click();return "joining"})()'
PICK='(async()=>{const r=await fetch("/test-photo.png");const b=await r.blob();const dt=new DataTransfer();dt.items.add(new File([b],"golden-bay.png",{type:"image/png"}));const inp=document.querySelector("input[type=file]");inp.files=dt.files;inp.dispatchEvent(new Event("change",{bubbles:true}));return "picked "+b.size})()'

# 2) neo joins (default session)
$AB close >/dev/null 2>&1
$AB open http://127.0.0.1:81/ >/dev/null
$AB wait --load networkidle >/dev/null 2>&1
$AB wait --text "Enter the room" >/dev/null
NEO_JOIN="${JOIN/@@NAME@@/neo}"
$AB eval "$NEO_JOIN" >/dev/null
for i in $(seq 1 30); do
  M=$($AB eval "JSON.stringify([...document.querySelectorAll('.oc-member-name')].map(e=>e.textContent))" 2>/dev/null)
  echo "$M" | rg -q neo && { echo "neo connected: $M"; break; }
  sleep 1
done

# 3) trinity joins (second browser session, same room)
$AB --session trinity open http://127.0.0.1:81/ >/dev/null
$AB --session trinity wait --text "Enter the room" >/dev/null
TRI_JOIN="${JOIN/@@NAME@@/trinity}"
$AB --session trinity eval "$TRI_JOIN" >/dev/null
sleep 3
echo "members: $($AB eval "JSON.stringify([...document.querySelectorAll('.oc-member-name')].map(e=>e.textContent))")"

# 4) wiretap client (proves relay sees only ciphertext)
node scripts/spy_client.mjs > /tmp/spy.log 2>&1 &
SPY=$!
sleep 2

# 5) pick -> confirm sheet appears (nothing sent yet)
$AB eval "$PICK" >/dev/null
sleep 1.5
$AB wait --text "Send photo?" >/dev/null
echo "sheet: $($AB eval "JSON.stringify({open: !!document.querySelector('.oc-confirm'), preview: !!document.querySelector('.oc-confirm-preview img'), meta: (document.querySelector('.oc-confirm-meta span')||{}).textContent, msgs: document.querySelectorAll('.oc-msg').length})")"
$AB screenshot /tmp/shots/01-confirm-sheet.png >/dev/null

# 6) cancel -> nothing sent
$AB eval "document.querySelector('.oc-confirm-cancel').click()" >/dev/null
sleep 0.6
echo "after cancel: $($AB eval "JSON.stringify({sheet: !!document.querySelector('.oc-confirm'), msgs: document.querySelectorAll('.oc-msg').length})")"

# 7) escape dismisses
$AB eval "$PICK" >/dev/null
sleep 1.5
$AB press Escape
sleep 0.6
echo "after escape: $($AB eval "JSON.stringify({sheet: !!document.querySelector('.oc-confirm'), msgs: document.querySelectorAll('.oc-msg').length})")"

# 8) caption + Send -> sealed photo on the wire
$AB eval "$PICK" >/dev/null
sleep 1.5
$AB eval "(()=>{const c=document.querySelector('.oc-confirm-caption');const d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(c),'value');d.set.call(c,'Golden hour over the bay');c.dispatchEvent(new Event('input',{bubbles:true}));return 'caption set'})()" >/dev/null
$AB eval "document.querySelector('.oc-confirm-send').click()" >/dev/null
sleep 3
echo "neo after send: $($AB eval "JSON.stringify({sheet: !!document.querySelector('.oc-confirm'), imgs: document.querySelectorAll('.oc-img-thumb').length, caption: (document.querySelector('.oc-img-caption')||{}).textContent, src: ((document.querySelector('.oc-img-thumb')||{}).getAttribute('src')||'').slice(0,22)})")"
echo "spy log: $(cat /tmp/spy.log | tr '\n' ' | ')"
$AB screenshot /tmp/shots/02-neo-sent.png >/dev/null

# 9) trinity receives + decrypts the same photo
echo "trinity: $($AB --session trinity eval "JSON.stringify({imgs: document.querySelectorAll('.oc-img-thumb').length, caption: (document.querySelector('.oc-img-caption')||{}).textContent, members: [...document.querySelectorAll('.oc-member-name')].map(e=>e.textContent)})")"
$AB --session trinity screenshot /tmp/shots/03-trinity-received.png >/dev/null

# 10) reply to the photo — chip previews the caption, then send a text reply
$AB eval "document.querySelector('.oc-msg .oc-bubble').dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); 'dbl'" >/dev/null
sleep 0.5
echo "replybar: $($AB eval "JSON.stringify({show: !!document.querySelector('.oc-replybar.show'), text: (document.querySelector('.oc-rb-text')||{}).textContent})")"
$AB eval "(()=>{const c=document.querySelector('.oc-msg-input');const d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(c),'value');d.set.call(c,'Simply stunning');c.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.oc-send-btn').click();return 'sent'})()" >/dev/null
sleep 1.5
echo "reply chip: $($AB eval "JSON.stringify({chips: document.querySelectorAll('.oc-reply-chip').length, first: (document.querySelector('.oc-reply-chip .oc-reply-body')||{}).textContent})")"

# 11) mobile confirm sheet
$AB --session trinity set viewport 390 844 >/dev/null
$AB --session trinity eval "$PICK" >/dev/null
sleep 1.5
$AB --session trinity screenshot /tmp/shots/04-mobile-confirm.png >/dev/null
echo "mobile sheet open: $($AB --session trinity eval "!!document.querySelector('.oc-confirm')")"

$AB close >/dev/null 2>&1
$AB --session trinity close >/dev/null 2>&1
echo DONE
