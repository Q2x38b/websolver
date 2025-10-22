/* Basic state */
const state = {
  activeTab: 'home',
  mode: 'camera', // 'camera' | 'chat'
  selectedSubject: 'General',
  stream: null,
  crop: { x: 0, y: 0, w: 0, h: 0, active: false },
  history: JSON.parse(localStorage.getItem('history')||'[]'),
  apiKey: localStorage.getItem('gemini_api_key') || '',
  model: localStorage.getItem('gemini_model') || 'gemini-1.5-flash',
};

/* DOM refs */
const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

/* Router */
function switchTab(tab){
  state.activeTab = tab;
  $$('.page').forEach(p=>p.classList.remove('active'));
  $(`#page-${tab}`).classList.add('active');
  $$('.tabbar button').forEach(b=>b.classList.toggle('active', b.dataset.tab===tab));
  if(tab==='home' && state.mode==='camera'){ startCamera(); }
  else { stopCamera(); }
  if(tab==='explore') renderHistory();
  if(tab==='profile') loadSettings();
}

function switchMode(mode){
  state.mode = mode;
  $$('.segmented button').forEach(b=>b.classList.toggle('active', b.dataset.mode===mode));
  $('#cameraView').classList.toggle('hidden', mode!=='camera');
  $('#chatView').classList.toggle('hidden', mode!=='chat');
  if(mode==='camera'){ startCamera(); } else { stopCamera(); }
}

/* Camera */
async function startCamera(){
  try{
    const video = $('#camera');
    if(state.stream){ return; }
    const stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}}, audio:false});
    state.stream = stream;
    video.srcObject = stream;
    await video.play();
  }catch(err){
    console.error('Camera error', err);
    toast('Camera unavailable. You can upload from gallery.');
  }
}
function stopCamera(){
  if(state.stream){
    state.stream.getTracks().forEach(t=>t.stop());
    state.stream = null;
  }
}

function takePhoto(){
  const video = $('#camera');
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 1080;
  canvas.height = video.videoHeight || 1440;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video,0,0,canvas.width,canvas.height);
  openCropper(canvas.toDataURL('image/png'));
}

function onFileChosen(e){
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = () => openCropper(reader.result);
  reader.readAsDataURL(file);
  e.target.value = '';
}

/* Simple cropper: click-drag to draw rectangle */
let cropImage = new Image();
// Keep scale of drawn image to map back to original pixels
state.cropScale = 1;
function openCropper(dataUrl){
  cropImage = new Image();
  cropImage.onload = () => {
    const overlay = $('.cropper');
    // Ensure overlay is visible before measuring parent dimensions
    overlay.classList.add('active');
    const canvas = $('#cropCanvas');
    const parent = canvas.parentElement;
    const {width, height, scale} = fitContain(cropImage.width, cropImage.height, parent.clientWidth, parent.clientHeight);
    canvas.width = width; canvas.height = height;
    state.cropScale = scale;
    drawCropBase();
    state.crop = { x: Math.round(width*0.1), y: Math.round(height*0.1), w: Math.round(width*0.8), h: Math.round(height*0.8), active:false };
    drawCrop();
  };
  cropImage.src = dataUrl;
}

function fitContain(sw, sh, dw, dh){
  const s = Math.min(dw/sw, dh/sh);
  return { width: Math.round(sw*s), height: Math.round(sh*s), scale: s };
}

function drawCropBase(){
  const canvas = $('#cropCanvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.drawImage(cropImage,0,0,canvas.width,canvas.height);
}

function drawCrop(){
  const canvas = $('#cropCanvas');
  const ctx = canvas.getContext('2d');
  drawCropBase();
  const r = state.crop;
  ctx.save();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.restore();
}

function cropPointerDown(ev){
  const pt = getCanvasPoint(ev);
  state.crop.active = true;
  state.crop.startX = pt.x; state.crop.startY = pt.y;
  state.crop.orig = { ...state.crop };
}
function cropPointerMove(ev){
  if(!state.crop.active) return;
  const pt = getCanvasPoint(ev);
  const dx = pt.x - state.crop.startX;
  const dy = pt.y - state.crop.startY;
  const cv = $('#cropCanvas');
  state.crop.x = clamp(state.crop.orig.x + dx, 0, cv.width - 10);
  state.crop.y = clamp(state.crop.orig.y + dy, 0, cv.height - 10);
  state.crop.x = Math.max(0, Math.min(state.crop.x, cv.width - state.crop.w));
  state.crop.y = Math.max(0, Math.min(state.crop.y, cv.height - state.crop.h));
  drawCrop();
}
function cropPointerUp(){ state.crop.active = false; }

function getCanvasPoint(ev){
  const rect = $('#cropCanvas').getBoundingClientRect();
  const x = (ev.touches?ev.touches[0].clientX:ev.clientX) - rect.left;
  const y = (ev.touches?ev.touches[0].clientY:ev.clientY) - rect.top;
  return {x, y};
}
function clamp(v,min,max){ return Math.max(min, Math.min(max, v)); }

function confirmCropAndSolve(){
  const { x, y, w, h } = state.crop;
  // Map crop rectangle back to original image coordinates for better quality
  const scale = state.cropScale || 1;
  const sx = Math.round(x / scale);
  const sy = Math.round(y / scale);
  const sw = Math.round(w / scale);
  const sh = Math.round(h / scale);
  const out = document.createElement('canvas');
  out.width = sw; out.height = sh;
  const ctx = out.getContext('2d');
  ctx.drawImage(cropImage, sx, sy, sw, sh, 0, 0, sw, sh);
  const dataUrl = out.toDataURL('image/png');
  $('.cropper').classList.remove('active');
  solveWithGemini(dataUrl);
}
function closeCropper(){ $('.cropper').classList.remove('active'); }

/* Subjects */
function selectSubject(sub){
  state.selectedSubject = sub;
  $$('.chip').forEach(c=>c.classList.toggle('active', c.textContent===sub));
}

/* Gemini */
async function solveWithGemini(imageDataUrl){
  if(!state.apiKey){ toast('Add your Gemini API key in Profile.'); return; }
  const base64 = imageDataUrl.split(',')[1];
  const prompt = `You are an expert ${state.selectedSubject} tutor. Analyze the image and solve the problem. Provide step-by-step reasoning and a final concise answer.`;
  showThinking();
  try{
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${state.model}:generateContent?key=${encodeURIComponent(state.apiKey)}`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        contents:[{
          role:'user',
          parts:[{text:prompt},{inline_data:{mime_type:'image/png', data: base64}}]
        }]
      })
    });
    const json = await res.json();
    const text = json.candidates?.[0]?.content?.parts?.map(p=>p.text).join('') || JSON.stringify(json);
    addMessage('bot', text);
    saveHistory(imageDataUrl, text);
    hideThinking();
    switchMode('chat');
  }catch(e){
    console.error(e); hideThinking(); toast('Gemini request failed.');
  }
}

function showThinking(){ addMessage('bot', 'Thinking…'); }
function hideThinking(){ const last=$$('.message.bot').pop(); if(last && last.textContent==='Thinking…') last.remove(); }

/* Chat */
function addMessage(who, text){
  const messages = $('#messages');
  const el = document.createElement('div');
  el.className = `message ${who}`;
  el.textContent = text;
  messages.appendChild(el);
  messages.scrollTop = messages.scrollHeight;
}

async function sendChat(){
  const input = $('#chatInput');
  const text = input.value.trim();
  if(!text) return;
  input.value='';
  addMessage('user', text);
  if(!state.apiKey){ addMessage('bot','Add your Gemini API key in Profile.'); return; }
  try{
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${state.model}:generateContent?key=${encodeURIComponent(state.apiKey)}`,{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ contents:[{ role:'user', parts:[{text}] }] })
    });
    const json = await res.json();
    const reply = json.candidates?.[0]?.content?.parts?.map(p=>p.text).join('') || JSON.stringify(json);
    addMessage('bot', reply);
  }catch(e){ console.error(e); addMessage('bot','Request failed.'); }
}

/* History */
function saveHistory(imageDataUrl, answer){
  const entry = { id: Date.now(), image: imageDataUrl, subject: state.selectedSubject, answer };
  state.history.unshift(entry);
  localStorage.setItem('history', JSON.stringify(state.history.slice(0,50)));
}
function renderHistory(){
  const el = $('#history');
  el.innerHTML = '';
  for(const item of state.history){
    const card = document.createElement('div');
    card.className='card';
    const img = document.createElement('img'); img.src=item.image; card.appendChild(img);
    const meta = document.createElement('div'); meta.className='meta'; meta.textContent = `${item.subject}`; card.appendChild(meta);
    el.appendChild(card);
  }
}

/* Settings */
function loadSettings(){
  $('#apiKey').value = state.apiKey;
  $('#model').value = state.model;
}
function saveSettings(){
  state.apiKey = $('#apiKey').value.trim();
  state.model = $('#model').value;
  localStorage.setItem('gemini_api_key', state.apiKey);
  localStorage.setItem('gemini_model', state.model);
  toast('Saved');
}
function clearHistory(){ state.history=[]; localStorage.removeItem('history'); renderHistory(); toast('History cleared'); }

/* Utilities */
function toast(msg){
  let t = $('#toast');
  if(!t){ t = document.createElement('div'); t.id='toast'; t.style.position='fixed'; t.style.left='50%'; t.style.transform='translateX(-50%)'; t.style.bottom='90px'; t.style.background='rgba(0,0,0,.7)'; t.style.padding='10px 14px'; t.style.borderRadius='12px'; t.style.zIndex='9999'; t.style.color='#fff'; document.body.appendChild(t); }
  t.textContent = msg; t.style.opacity='1';
  setTimeout(()=>{ t.style.transition='opacity .6s'; t.style.opacity='0'; }, 1600);
}

/* Event wiring */
window.addEventListener('load', ()=>{
  // Tabs
  $$('.tabbar button').forEach(b=> b.addEventListener('click', ()=> switchTab(b.dataset.tab)) );
  switchTab('home');

  // Mode
  $$('.segmented button').forEach(b=> b.addEventListener('click', ()=> switchMode(b.dataset.mode)) );

  // Subjects
  $$('.subjects .chip').forEach(c=> c.addEventListener('click', ()=> selectSubject(c.textContent)) );

  // Camera controls
  $('#capture').addEventListener('click', takePhoto);
  $('#gallery').addEventListener('change', onFileChosen);

  // Cropper
  const cv = $('#cropCanvas');
  cv.addEventListener('mousedown', cropPointerDown);
  cv.addEventListener('mousemove', cropPointerMove);
  cv.addEventListener('mouseup', cropPointerUp);
  cv.addEventListener('touchstart', cropPointerDown, {passive:true});
  cv.addEventListener('touchmove', cropPointerMove, {passive:true});
  cv.addEventListener('touchend', cropPointerUp, {passive:true});
  $('#cropConfirm').addEventListener('click', confirmCropAndSolve);
  $('#cropCancel').addEventListener('click', closeCropper);

  // Chat
  $('#send').addEventListener('click', sendChat);
  $('#chatInput').addEventListener('keydown', (e)=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendChat(); } });

  // Settings
  $('#saveSettings').addEventListener('click', saveSettings);
  $('#clearHistory').addEventListener('click', clearHistory);

  // PWA
  if('serviceWorker' in navigator){ navigator.serviceWorker.register('./sw.js'); }
});
