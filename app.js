const RATE_VALUES=[0.5,1,2];

const initial=[
  {len:3, notes:[0,4,2,6,1,5,3], rate:2, root:0},
  {len:5, notes:[3,0,5,2,6,1,4], rate:2, root:0},
  {len:3, notes:[6,1,4,0,3,5,2], rate:1, root:0}
];

let tracks=structuredClone(initial);
let selected=0;
let playing=false;
let schedulerTimer=null;
let telemetryTimer=null;
let currentSeed=Math.floor(Math.random()*10000);
let playStartContextTime=0;
let accumulatedPlayTime=0;
let audio=null;
let masterInput=null;
let masterOutput=null;
let dryGain=null;
let wetGain=null;
let convolver=null;
let delayNode=null;
let delayWetGain=null;
let delayFeedback=null;

let cloudInput=null;
let cloudWetGain=null;
let wallWetGain=null;
let wallDelays=[];
let wallFeedbacks=[];
let cloudDelays=[];
let cloudFeedbacks=[];
let cloudLFOs=[];

let reverbAmount=0.10;
let delayAmount=0;
let masterVolume=0.78;
let pos=[0,0,0];
let lastPlayed=[-1,-1,-1];

let BPM=120;
// Shared master grid. One tick = 1/16 note at 120 BPM.
// All RATE values are derived from this absolute grid, so changing RATE never resets phase.
let GRID_PERIOD=(60/BPM)/4;
let gridIndex=0;
let nextGridTime=0;
const base=65.40639133;
const freqs=Array.from({length:7},(_,i)=>base*Math.pow(3/2,i));

const ROOT_VALUES=[-1,0,1,2]; // -V, 0, +V, +1 octave

function rootText(root){
  if(root===-1) return "-V";
  if(root===1) return "+V";
  if(root===2) return "+1";
  return "0";
}

function rootMultiplier(root){
  if(root===-1) return 2/3;
  if(root===1) return 3/2;
  if(root===2) return 2;
  return 1;
}


function setBPM(value){
  BPM=Math.max(30,Math.min(300,Math.round(value)));
  GRID_PERIOD=(60/BPM)/4;
  if(delayNode && audio){
    delayNode.delayTime.setTargetAtTime((60/BPM)*0.75,audio.currentTime,0.02);
  }
  const out=document.querySelector("#bpmValue");
  if(out) out.textContent=BPM;
}

function updateDelayMix(){
  if(!delayWetGain || !delayFeedback || !audio) return;

  const x=delayAmount;

  // Keep the musical behaviour of v0.23 through most of the slider.
  const cloudStart=0.50;
  const cloudProgress=Math.max(0,(x-cloudStart)/(1-cloudStart));

  // Only the far-right region becomes the WALL.
  const wallStart=0.72;
  const wallProgress=Math.max(0,(x-wallStart)/(1-wallStart));

  // Tempo-synced echo remains present, but recedes as the wall gets dense.
  const echoWet=x*0.62*(1-cloudProgress*0.28)*(1-wallProgress*0.38);
  const feedback=0.16 + Math.pow(Math.max(0,(x-0.35)/0.65),1.45)*0.68;

  delayWetGain.gain.setTargetAtTime(echoWet,audio.currentTime,0.015);
  delayFeedback.gain.setTargetAtTime(Math.min(0.84,feedback),audio.currentTime,0.02);

  // Gentle v0.23 cloud, without the aggressive pitch modulation from v0.24.
  if(cloudWetGain){
    const cloudWet=Math.pow(cloudProgress,1.15)*0.58*(1-wallProgress*0.25);
    cloudWetGain.gain.setTargetAtTime(cloudWet,audio.currentTime,0.025);
  }

  if(cloudFeedbacks.length){
    const cloudFb=0.10 + Math.pow(cloudProgress,1.4)*0.50;
    cloudFeedbacks.forEach((fb,idx)=>{
      const spread=1-(idx*0.035);
      fb.gain.setTargetAtTime(Math.min(0.62,cloudFb*spread),audio.currentTime,0.03);
    });
  }

  // WALL is not a wobble. It is density: eight close delay lines pile up.
  if(wallWetGain){
    const wallWet=Math.pow(wallProgress,0.72)*0.95;
    wallWetGain.gain.setTargetAtTime(wallWet,audio.currentTime,0.025);
  }

  if(wallFeedbacks.length){
    // Much more regenerative near the far right.
    // The curve stays restrained until the WALL zone, then rises sharply.
    const wallFb=0.16 + Math.pow(wallProgress,0.68)*0.77;
    wallFeedbacks.forEach((fb,idx)=>{
      const spread=1-(idx*0.010);
      fb.gain.setTargetAtTime(Math.min(0.93,wallFb*spread),audio.currentTime,0.028);
    });
  }
}

function setDelayAmount(value){
  delayAmount=Math.max(0,Math.min(1,value));
  const pct=Math.round(delayAmount*100);
  const fill=document.querySelector("#delayFill");
  const handle=document.querySelector("#delayHandle");
  const label=document.querySelector("#delayValue");
  const slider=document.querySelector("#delaySlider");

  if(fill) fill.style.width=pct+"%";
  if(handle) handle.style.left=pct+"%";
  if(label) label.textContent=String(pct).padStart(2,"0");
  if(slider) slider.setAttribute("aria-valuenow",pct);

  updateDelayMix();
}

function bindDelaySlider(){
  const el=document.querySelector("#delaySlider");
  if(!el) return;
  let pointerId=null;

  function setFromPointer(e){
    const rect=el.getBoundingClientRect();
    setDelayAmount((e.clientX-rect.left)/rect.width);
  }

  el.addEventListener("pointerdown",e=>{
    pointerId=e.pointerId;
    el.setPointerCapture?.(e.pointerId);
    setFromPointer(e);
    e.preventDefault();
  });
  el.addEventListener("pointermove",e=>{
    if(pointerId!==e.pointerId) return;
    setFromPointer(e);
    e.preventDefault();
  });
  el.addEventListener("pointerup",e=>{
    if(pointerId!==e.pointerId) return;
    setFromPointer(e);
    pointerId=null;
    e.preventDefault();
  });
  el.addEventListener("pointercancel",()=>{pointerId=null;});
}

function updateMasterVolume(){
  if(!masterOutput || !audio) return;
  // Mildly curved response gives more useful resolution in the lower half.
  const gain=Math.pow(masterVolume,1.35);
  masterOutput.gain.setTargetAtTime(gain,audio.currentTime,0.015);
}

function setMasterVolume(value){
  masterVolume=Math.max(0,Math.min(1,value));
  const pct=Math.round(masterVolume*100);

  const fill=document.querySelector("#volumeFill");
  const handle=document.querySelector("#volumeHandle");
  const label=document.querySelector("#volumeValue");
  const slider=document.querySelector("#volumeSlider");

  if(fill) fill.style.width=pct+"%";
  if(handle) handle.style.left=pct+"%";
  if(label) label.textContent=String(pct).padStart(2,"0");
  if(slider) slider.setAttribute("aria-valuenow",pct);

  updateMasterVolume();
}

function bindVolumeSlider(){
  const el=document.querySelector("#volumeSlider");
  if(!el) return;

  let pointerId=null;

  function setFromPointer(e){
    const rect=el.getBoundingClientRect();
    setMasterVolume((e.clientX-rect.left)/rect.width);
  }

  el.addEventListener("pointerdown",e=>{
    pointerId=e.pointerId;
    el.setPointerCapture?.(e.pointerId);
    setFromPointer(e);
    e.preventDefault();
  });

  el.addEventListener("pointermove",e=>{
    if(pointerId!==e.pointerId) return;
    setFromPointer(e);
    e.preventDefault();
  });

  el.addEventListener("pointerup",e=>{
    if(pointerId!==e.pointerId) return;
    setFromPointer(e);
    pointerId=null;
    e.preventDefault();
  });

  el.addEventListener("pointercancel",()=>{pointerId=null;});
}

function setReverbAmount(value){
  reverbAmount=Math.max(0,Math.min(1,value));

  const pct=Math.round(reverbAmount*100);
  const fill=document.querySelector("#reverbFill");
  const handle=document.querySelector("#reverbHandle");
  const label=document.querySelector("#reverbValue");
  const slider=document.querySelector("#reverbSlider");

  if(fill) fill.style.width=pct+"%";
  if(handle) handle.style.left=pct+"%";
  if(label) label.textContent=String(pct).padStart(2,"0");
  if(slider) slider.setAttribute("aria-valuenow",pct);

  updateReverbMix();
}

function bindReverbSlider(){
  const el=document.querySelector("#reverbSlider");
  if(!el) return;

  let pointerId=null;

  function setFromPointer(e){
    const rect=el.getBoundingClientRect();
    setReverbAmount((e.clientX-rect.left)/rect.width);
  }

  el.addEventListener("pointerdown",e=>{
    pointerId=e.pointerId;
    el.setPointerCapture?.(e.pointerId);
    setFromPointer(e);
    e.preventDefault();
  });

  el.addEventListener("pointermove",e=>{
    if(pointerId!==e.pointerId) return;
    setFromPointer(e);
    e.preventDefault();
  });

  el.addEventListener("pointerup",e=>{
    if(pointerId!==e.pointerId) return;
    setFromPointer(e);
    pointerId=null;
    e.preventDefault();
  });

  el.addEventListener("pointercancel",()=>{pointerId=null;});
}

function updateSeedDisplay(){
  const el=document.querySelector("#seedValue");
  if(el) el.textContent=String(currentSeed).padStart(4,"0");
}

function updateTelemetry(){
  let elapsed=accumulatedPlayTime;
  if(playing && audio) elapsed += Math.max(0,audio.currentTime-playStartContextTime);

  tracks.forEach((t,i)=>{
    // Base sequencer step = a 16th note. RATE scales how quickly this track consumes steps.
    const stepSeconds=((60/BPM)/4)/t.rate;
    const cycleSeconds=Math.max(0.001,stepSeconds*t.len);

    const completed=Math.floor(elapsed/cycleSeconds);
    const within=elapsed-(completed*cycleSeconds);

    const cycleEl=document.querySelector(`#cycle${i+1}Value`);
    const timeEl=document.querySelector(`#cycle${i+1}Time`);

    if(cycleEl) cycleEl.textContent=String(completed).padStart(4,"0");
    if(timeEl) timeEl.textContent=within.toFixed(3).padStart(5,"0");
  });

  const clockEl=document.querySelector("#clockValue");
  if(clockEl){
    const now=new Date();
    const hh=String(now.getHours()).padStart(2,"0");
    const mm=String(now.getMinutes()).padStart(2,"0");
    const ss=String(now.getSeconds()).padStart(2,"0");
    const ms=String(now.getMilliseconds()).padStart(3,"0");
    clockEl.textContent=`${hh}:${mm}:${ss}.${ms}`;
  }
}

function startTelemetry(){
  if(telemetryTimer) clearInterval(telemetryTimer);
  telemetryTimer=setInterval(updateTelemetry,33);
  updateTelemetry();
}

function randomizeAllTracks(){
  currentSeed=Math.floor(Math.random()*10000);
  updateSeedDisplay();

  // Start all three CYCLE counters from zero again.
  accumulatedPlayTime=0;
  if(playing && audio){
    playStartContextTime=audio.currentTime;
  }
  updateTelemetry();

  tracks.forEach((t,i)=>{
    // Phrase length, rate and root are all part of the compositional system.
    t.len=1+Math.floor(Math.random()*7);
    t.rate=RATE_VALUES[Math.floor(Math.random()*RATE_VALUES.length)];
    t.root=ROOT_VALUES[Math.floor(Math.random()*ROOT_VALUES.length)];

    // Rebuild all seven stored pitch positions, even if some are currently inactive.
    t.notes=t.notes.map(()=>Math.floor(Math.random()*7));

    pos[i]=0;
    lastPlayed[i]=-1;
  });

  render();
}

function bindRandomAll(){
  const el=document.querySelector("#randomAll");
  if(!el) return;
  el.addEventListener("pointerup",e=>{
    e.preventDefault();
    randomizeAllTracks();
  });
}

function bindBPMControl(){
  const el=document.querySelector("#bpmControl");
  if(!el) return;

  let pointerId=null;
  let startY=0;
  let startBPM=120;
  let dragged=false;

  el.addEventListener("pointerdown",e=>{
    pointerId=e.pointerId;
    startY=e.clientY;
    startBPM=BPM;
    dragged=false;
    el.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });

  el.addEventListener("pointermove",e=>{
    if(pointerId!==e.pointerId) return;
    const dy=e.clientY-startY;
    if(Math.abs(dy)>3) dragged=true;
    if(dragged){
      // 1 BPM per ~2 px, vertical like the note sliders.
      setBPM(startBPM + Math.round(-dy/2));
    }
    e.preventDefault();
  });

  el.addEventListener("pointerup",e=>{
    if(pointerId!==e.pointerId) return;
    if(!dragged){
      // Simple tap nudges +5 BPM; wraps after 300.
      setBPM(BPM>=300 ? 30 : BPM+5);
    }
    pointerId=null;
    e.preventDefault();
  });

  el.addEventListener("pointercancel",()=>{pointerId=null;});
}

function buildHallImpulse(ctx, seconds=5.8, decay=3.2){
  const length=Math.floor(ctx.sampleRate*seconds);
  const impulse=ctx.createBuffer(2,length,ctx.sampleRate);

  for(let ch=0;ch<2;ch++){
    const data=impulse.getChannelData(ch);
    for(let i=0;i<length;i++){
      const t=i/length;
      // Dense synthetic hall tail with a slow exponential fade.
      data[i]=(Math.random()*2-1)*Math.pow(1-t,decay);
    }
  }
  return impulse;
}

function setupMasterFX(){
  masterInput=audio.createGain();
  masterOutput=audio.createGain();
  masterOutput.gain.value=masterVolume;
  masterOutput.connect(audio.destination);

  dryGain=audio.createGain();
  wetGain=audio.createGain();
  convolver=audio.createConvolver();

  convolver.buffer=buildHallImpulse(audio);

  delayNode=audio.createDelay(2.0);
  delayWetGain=audio.createGain();
  delayFeedback=audio.createGain();

  masterInput.connect(dryGain).connect(masterOutput);
  masterInput.connect(convolver).connect(wetGain).connect(masterOutput);

  // Main tempo-locked echo.
  delayNode.delayTime.value=(60/BPM)*0.75;
  delayFeedback.gain.value=0.18;

  masterInput.connect(delayNode);
  delayNode.connect(delayWetGain).connect(masterOutput);
  delayNode.connect(delayFeedback).connect(delayNode);

  // CLOUD: lightweight granular-like diffusion.
  // Four short delay lines, each moving slowly by a few milliseconds.
  cloudInput=audio.createGain();
  cloudWetGain=audio.createGain();
  cloudWetGain.gain.value=0;

  const cloudSum=audio.createGain();
  cloudSum.gain.value=0.28;

  const cloudTimes=[0.037,0.061,0.089,0.127];
  const lfoRates=[0.11,0.17,0.23,0.31];
  const lfoDepths=[0.004,0.006,0.008,0.010];

  cloudDelays=[];
  cloudFeedbacks=[];
  cloudLFOs=[];

  cloudTimes.forEach((time,idx)=>{
    const d=audio.createDelay(0.4);
    const fb=audio.createGain();
    const branch=audio.createGain();
    const lfo=audio.createOscillator();
    const depth=audio.createGain();

    d.delayTime.value=time;
    fb.gain.value=0.12;
    branch.gain.value=0.82;

    lfo.type="sine";
    lfo.frequency.value=lfoRates[idx];
    depth.gain.value=lfoDepths[idx];

    lfo.connect(depth).connect(d.delayTime);
    lfo.start();

    cloudInput.connect(d);
    d.connect(branch).connect(cloudSum);
    d.connect(fb).connect(d);

    cloudDelays.push(d);
    cloudFeedbacks.push(fb);
    cloudLFOs.push(lfo);
  });

  masterInput.connect(cloudInput);
  cloudSum.connect(cloudWetGain).connect(masterOutput);

  // WALL: dense, static echo diffusion for the far-right part of ECHO.
  // Many close, non-metrical taps overlap until individual repeats blur together.
  wallWetGain=audio.createGain();
  wallWetGain.gain.value=0;
  const wallSum=audio.createGain();
  wallSum.gain.value=0.19;
  const wallTimes=[0.071,0.103,0.137,0.181,0.239,0.307,0.389,0.487];
  wallDelays=[];
  wallFeedbacks=[];

  wallTimes.forEach((time,idx)=>{
    const d=audio.createDelay(1.0);
    const fb=audio.createGain();
    const branch=audio.createGain();

    d.delayTime.value=time;
    fb.gain.value=0.12;
    branch.gain.value=0.72-(idx*0.035);

    masterInput.connect(d);
    d.connect(branch).connect(wallSum);
    d.connect(fb).connect(d);

    wallDelays.push(d);
    wallFeedbacks.push(fb);
  });

  wallSum.connect(wallWetGain).connect(masterOutput);

  updateReverbMix();
  updateDelayMix();
}

function updateReverbMix(){
  if(!dryGain || !wetGain) return;

  // Keep some direct signal until the extreme end; wet rises smoothly.
  const x=reverbAmount;
  const dry=Math.cos(x*Math.PI*0.5);
  const wet=Math.sin(x*Math.PI*0.5)*0.82;

  dryGain.gain.setTargetAtTime(dry,audio.currentTime,0.015);
  wetGain.gain.setTargetAtTime(wet,audio.currentTime,0.015);
}

function ensureAudio(){
  if(!audio){
    audio=new (window.AudioContext||window.webkitAudioContext)();
    setupMasterFX();
  }
  if(audio.state==="suspended") audio.resume();
}

function voiceAt(freq, track, when){
  const out=audio.createGain();
  out.connect(masterInput);

  const level=[0.072,0.060,0.050][track];
  out.gain.setValueAtTime(0.0001,when);
  out.gain.exponentialRampToValueAtTime(level,when+.008);
  out.gain.exponentialRampToValueAtTime(0.0001,when+.18);

  if(track===0){
    // PURE: almost naked sine.
    const osc=audio.createOscillator();
    osc.type="sine";
    osc.frequency.value=freq;
    osc.connect(out);
    osc.start(when);
    osc.stop(when+.19);
  }

  if(track===1){
    // HOLLOW: sine fundamental + a quiet third harmonic.
    const fundamental=audio.createOscillator();
    const harmonic=audio.createOscillator();
    const hGain=audio.createGain();

    fundamental.type="sine";
    harmonic.type="sine";
    fundamental.frequency.value=freq;
    harmonic.frequency.value=freq*3;

    hGain.gain.value=0.16;
    fundamental.connect(out);
    harmonic.connect(hGain).connect(out);

    fundamental.start(when);
    harmonic.start(when);
    fundamental.stop(when+.19);
    harmonic.stop(when+.19);
  }

  if(track===2){
    // DUST: sine body plus a very short filtered noise transient.
    const osc=audio.createOscillator();
    osc.type="sine";
    osc.frequency.value=freq;
    osc.connect(out);
    osc.start(when);
    osc.stop(when+.19);

    const buffer=audio.createBuffer(1,Math.max(1,Math.floor(audio.sampleRate*0.025)),audio.sampleRate);
    const data=buffer.getChannelData(0);
    for(let i=0;i<data.length;i++) data[i]=(Math.random()*2-1)*(1-i/data.length);

    const noise=audio.createBufferSource();
    const filter=audio.createBiquadFilter();
    const nGain=audio.createGain();
    noise.buffer=buffer;
    filter.type="highpass";
    filter.frequency.value=1800;
    nGain.gain.value=0.12;

    noise.connect(filter).connect(nGain).connect(out);
    noise.start(when);
  }
}

function rateGridInterval(rate){
  // GRID_PERIOD is a sixteenth-note grid.
  // x2 = every 1 grid tick, x1 = every 2, x1/2 = every 4.
  if(rate===2) return 1;
  if(rate===1) return 2;
  return 4;
}

function schedule(){
  if(!playing || !audio) return;
  const horizon=audio.currentTime+0.10;

  while(nextGridTime < horizon){
    const tickIndex=gridIndex;
    const tickTime=nextGridTime;

    tracks.forEach((t,i)=>{
      const interval=rateGridInterval(t.rate);

      // Because this tests against one shared integer grid, RATE changes preserve alignment.
      if(tickIndex % interval !== 0) return;

      const p=pos[i]%t.len;
      voiceAt(freqs[t.notes[p]]*rootMultiplier(t.root),i,tickTime);

      const delay=Math.max(0,(tickTime-audio.currentTime)*1000);
      const playedIndex=p;
      setTimeout(()=>{
        if(playing){
          lastPlayed[i]=playedIndex;
          updatePlayheads();
        }
      },delay);

      pos[i]=(p+1)%t.len;
    });

    gridIndex++;
    nextGridTime += GRID_PERIOD;
  }
}

function start(){
  ensureAudio();
  playing=true;
  playStartContextTime=audio.currentTime;
  gridIndex=0;
  nextGridTime=audio.currentTime+0.05;
  schedule();
  schedulerTimer=setInterval(schedule,25);
  render();
}
function stop(){
  if(playing && audio){
    accumulatedPlayTime+=Math.max(0,audio.currentTime-playStartContextTime);
  }
  playing=false;
  clearInterval(schedulerTimer);
  schedulerTimer=null;
  lastPlayed=[-1,-1,-1];
  render();
}
function toggle(){playing?stop():start();}

function rateText(x){
  if(Math.abs(x-.5)<.001) return "1/2";
  if(x===1) return "1";
  return "2x";
}

function rateEqual(a,b){
  return Math.abs(a-b)<.001;
}

function pitchToBottom(pitch){
  return (pitch/6)*100;
}

function bindPitchInteraction(stepEl, noteEl, ti, si){
  let pointerId=null;
  let startY=0;
  let startPitch=0;
  let currentPitch=0;
  let dragged=false;
  const pixelsPerStep=11;

  stepEl.addEventListener("pointerdown",e=>{
    selected=ti;
    pointerId=e.pointerId;
    startY=e.clientY;
    startPitch=tracks[ti].notes[si];
    currentPitch=startPitch;
    dragged=false;
    stepEl.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });

  stepEl.addEventListener("pointermove",e=>{
    if(pointerId!==e.pointerId) return;
    const dy=e.clientY-startY;
    if(Math.abs(dy)>3) dragged=true;

    if(dragged){
      const delta=Math.round(-dy/pixelsPerStep);
      const pitch=Math.max(0,Math.min(6,startPitch+delta));
      if(pitch!==currentPitch){
        currentPitch=pitch;
        tracks[ti].notes[si]=pitch;
        noteEl.style.bottom=pitchToBottom(pitch)+"%";
      }
    }
    e.preventDefault();
  });

  stepEl.addEventListener("pointerup",e=>{
    if(pointerId!==e.pointerId) return;

    if(!dragged){
      const pitch=(tracks[ti].notes[si]+1)%7;
      tracks[ti].notes[si]=pitch;
      noteEl.style.bottom=pitchToBottom(pitch)+"%";
    }

    pointerId=null;
    render();
    e.preventDefault();
  });

  stepEl.addEventListener("pointercancel",()=>{
    pointerId=null;
    render();
  });
}

function updatePlayheads(){
  document.querySelectorAll(".step").forEach(el=>el.classList.remove("playing-step"));
  tracks.forEach((t,ti)=>{
    const s=lastPlayed[ti];
    if(s<0) return;
    const el=document.querySelector(`[data-step="${ti}-${s}"]`);
    if(el) el.classList.add("playing-step");
  });
}

function render(){
  const host=document.querySelector("#tracks");
  host.innerHTML="";

  tracks.forEach((t,ti)=>{
    const el=document.createElement("div");
    el.className="track"+(ti===selected?" selected-track":"");

    const rates=RATE_VALUES.map((r,ri)=>
      `<button class="rate-btn ${rateEqual(t.rate,r)?"active":""}" data-rate="${ti}-${ri}">
        ${rateText(r)}
      </button>`
    ).join("");

    el.innerHTML=`<div class="meta">
      <button class="drag" data-select="${ti}" aria-label="select track ${ti+1}">⠿</button>

      <div class="track-head">
        <div class="num">0${ti+1}</div>
        <button class="steps-inline" data-length="${ti}">
          <span class="steps-inline-value">${t.len}</span>
          <span class="steps-inline-label">STEPS</span>
        </button>
      </div>

      <div class="meta-rate">
        <span class="meta-rate-label">RATE</span>
        <div class="meta-rate-buttons">${rates}</div>
      </div>

      <div class="root-bank">
        <span class="root-label">ROOT</span>
        <div class="root-buttons">
          ${ROOT_VALUES.map(r=>`<button class="root-btn ${t.root===r?"active":""}" data-root="${ti}:${r}">${rootText(r)}</button>`).join("")}
        </div>
      </div>

      <div class="track-dot"></div>
    </div>

    <div class="grid"></div>

    <button class="trackplay" data-trackplay="${ti}">▷</button>`;

    const grid=el.querySelector(".grid");

    for(let s=0;s<7;s++){
      const active=s<t.len;
      const val=t.notes[s] ?? 0;
      const st=document.createElement("div");
      st.className="step"+(active?"":" inactive");
      st.dataset.step=`${ti}-${s}`;

      st.innerHTML=`<span class="n">0${s+1}</span>
        <span class="rail-wrap">
          <span class="rail">
            <i class="note" style="bottom:${pitchToBottom(val)}%"></i>
          </span>
        </span>
        <span class="base-row"><i class="base"></i></span>`;

      grid.appendChild(st);

      if(active){
        bindPitchInteraction(st,st.querySelector(".note"),ti,s);
      }
    }

    host.appendChild(el);
  });

  document.querySelectorAll("[data-select]").forEach(x=>{
    x.onclick=()=>{
      selected=+x.dataset.select;
      render();
    };
  });

  document.querySelectorAll("[data-length]").forEach(x=>{
    x.addEventListener("pointerup",e=>{
      e.preventDefault();
      e.stopPropagation();
      const i=+x.dataset.length;
      selected=i;
      tracks[i].len=(tracks[i].len%7)+1;
      pos[i]%=tracks[i].len;
      render();
    });
  });

  document.querySelectorAll("[data-rate]").forEach(x=>{
    x.addEventListener("pointerup",e=>{
      e.preventDefault();
      e.stopPropagation();

      const [ti,ri]=x.dataset.rate.split("-").map(Number);
      selected=ti;
      tracks[ti].rate=RATE_VALUES[ri];

      // No clock reset here: the new RATE takes effect on the shared grid.
      render();
    });
  });

  document.querySelectorAll("[data-root]").forEach(x=>{
    x.addEventListener("pointerup",e=>{
      e.preventDefault();
      e.stopPropagation();
      const sep=x.dataset.root.indexOf(":");
      const ti=Number(x.dataset.root.slice(0,sep));
      const root=Number(x.dataset.root.slice(sep+1));
      selected=ti;
      tracks[ti].root=root;
      render();
    });
  });

  document.querySelectorAll("[data-trackplay]").forEach(x=>{
    x.onclick=()=>{
      selected=+x.dataset.trackplay;
      ensureAudio();
      const t=tracks[selected];
      const p=pos[selected]%t.len;
      voiceAt(freqs[t.notes[p]]*rootMultiplier(t.root),selected,audio.currentTime);
      render();
    };
  });

  document.querySelector("#masterPlay").textContent=playing?"■":"▶";
  document.querySelector("#editLabel").textContent=`EDIT 0${selected+1}`;
  updatePlayheads();
}

document.querySelector("#masterPlay").onclick=toggle;
updateSeedDisplay();
startTelemetry();
bindBPMControl();
bindRandomAll();
bindReverbSlider();
bindDelaySlider();
bindVolumeSlider();
setBPM(BPM);
setReverbAmount(reverbAmount);
setDelayAmount(delayAmount);
setMasterVolume(masterVolume);

document.querySelectorAll(".tools button").forEach(btn=>btn.onclick=()=>{
  const t=tracks[selected];
  const a=btn.dataset.action;

  if(a==="rotate"){
    const active=t.notes.slice(0,t.len);
    active.push(active.shift());
    t.notes=active.concat(t.notes.slice(t.len));
  }

  if(a==="up"){
    // Raise each pitch one fifth-chain step, but stop at the top.
    t.notes=t.notes.map(n=>Math.min(6,n+1));
  }

  if(a==="down"){
    // Lower each pitch one fifth-chain step, but stop at the bottom.
    t.notes=t.notes.map(n=>Math.max(0,n-1));
  }

  if(a==="mirror"){
    t.notes=t.notes.map(n=>6-n);
  }

  if(a==="reroll"){
    for(let i=0;i<t.len;i++){
      t.notes[i]=Math.floor(Math.random()*7);
    }
  }

  render();
});

render();
