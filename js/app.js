/* ============================================================
   Spell Rush · 听音拼词
   单机：3 滴血，词库不重复
   联机：MQTT 房间，30 秒/轮，答对 +100/+150/+200
   ============================================================ */
(() => {
  'use strict';

  /* ---------------- 常量 ---------------- */
  const WORDS = (window.SPELL_WORDS || []).slice();
  const BROKER = 'wss://broker.emqx.io:8084/mqtt';
  const ROOT = 'spellrush/v1/';
  const TOTAL_HEARTS = 3;
  const ROUND_TIME = 30000;
  const ROUND_POINTS = [100, 150, 200];
  const MAX_ROUNDS = 3;
  const MATCH_TARGET = 500;
  const MAX_WORDS = 8;
  const COUNTDOWN_MS = 3000;
  const REVEAL_MS = { wrong: 1500, correct: 2600, none: 3200 };
  const PRESENCE_EVERY = 2500;
  const GUEST_TIMEOUT = 9000;
  const HOST_TIMEOUT = 8000;

  /* ---------------- DOM ---------------- */
  const $ = (id) => document.getElementById(id);
  const netStatusEl = $('netStatus');
  const netText = $('netText');
  const screens = {
    home: $('screenHome'),
    solo: $('screenSolo'),
    lobby: $('screenLobby'),
    multi: $('screenMulti')
  };

  const btnSolo = $('btnSolo');
  const btnMulti = $('btnMulti');

  // 单机
  const soloHeartsEl = $('soloHearts');
  const soloCorrectEl = $('soloCorrect');
  const soloStreakEl = $('soloStreak');
  const soloIndex = $('soloIndex');
  const soloPool = $('soloPool');
  const soloForm = $('soloForm');
  const soloInput = $('soloInput');
  const soloSubmit = $('soloSubmit');
  const soloFeedback = $('soloFeedback');
  const soloPlayUk = $('soloPlayUk');
  const soloPlayUs = $('soloPlayUs');

  // 大厅
  const lobbyEntry = $('lobbyEntry');
  const roomBox = $('roomBox');
  const nameInput = $('nameInput');
  const roomInput = $('roomInput');
  const btnCreate = $('btnCreate');
  const btnJoin = $('btnJoin');
  const lobbyTip = $('lobbyTip');
  const roomCodeText = $('roomCodeText');
  const roomStatus = $('roomStatus');
  const rpMeName = $('rpMeName');
  const rpOppName = $('rpOppName');
  const rpOpp = document.querySelector('.rp.opp');
  const btnCopyRoom = $('btnCopyRoom');
  const btnHostStart = $('btnHostStart');
  const btnLeaveRoom = $('btnLeaveRoom');
  const btnMultiLeave = $('btnMultiLeave');

  // 联机对战
  const multiMatchMeta = $('multiMatchMeta');
  const cardMe = $('cardMe');
  const cardOpp = $('cardOpp');
  const meNameEl = $('meName');
  const oppNameEl = $('oppName');
  const meScoreEl = $('meScore');
  const oppScoreEl = $('oppScore');
  const wordNoEl = $('wordNo');
  const timerBar = $('timerBar');
  const timerFill = $('timerFill');
  const timerNum = $('timerNum');
  const multiRound = $('multiRound');
  const multiPoints = $('multiPoints');
  const multiWords = $('multiWords');
  const multiPlayUk = $('multiPlayUk');
  const multiPlayUs = $('multiPlayUs');
  const multiForm = $('multiForm');
  const multiInput = $('multiInput');
  const multiSubmit = $('multiSubmit');
  const multiFeedback = $('multiFeedback');

  // 浮层
  const overlay = $('overlay');
  const ovEyebrow = $('ovEyebrow');
  const ovTitle = $('ovTitle');
  const ovDesc = $('ovDesc');
  const ovPrimary = $('ovPrimary');
  const ovSecondary = $('ovSecondary');

  /* ---------------- 通用工具 ---------------- */
  let activeScreenId = 'screenHome';
  let accentPref = 'us';

  function showScreen(id) {
    if (activeScreenId === id) return;
    Object.values(screens).forEach((el) => el.classList.toggle('is-active', el.id === id));
    activeScreenId = id;
  }

  function shuffle(list) {
    const arr = list.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function esc(str) {
    return String(str).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[m]);
  }

  function norm(str) {
    return String(str || '').toLowerCase().replace(/[^a-z]/g, '');
  }

  function isSameSpelling(a, b) {
    return norm(a) !== '' && norm(a) === norm(b);
  }

  function cleanName(name) {
    return String(name || '').replace(/[<>&"']/g, '').trim().slice(0, 10);
  }

  function isFinePointer() {
    return window.matchMedia && window.matchMedia('(pointer: fine)').matches;
  }

  /* ---------------- 发音 ----------------
     按需加载：每个词用到时才 fetch（~22KB）+ decodeAudioData 解码缓存为 PCM，
     播放是采样级调度，无缓冲卡顿；页面无需预载，秒开。
     fetch 不可用时（file:// 直开）回退 <audio> 元素直读，再失败回退系统 TTS。 */
  let audioCtx = null;
  const decodedCache = new Map(); // key: word|accent -> Promise<AudioBuffer>
  let activeSource = null;

  function ensureAudioCtx() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  function getWordBuffer(word, acc) {
    const key = word.toLowerCase() + '|' + acc;
    if (decodedCache.has(key)) return decodedCache.get(key);
    const p = (async () => {
      const ctx = ensureAudioCtx();
      if (!ctx) throw new Error('no AudioContext');
      const res = await fetch('words/' + encodeURIComponent(word) + '_' + acc + '.mp3');
      if (!res.ok) throw new Error('audio ' + res.status);
      return await ctx.decodeAudioData(await res.arrayBuffer());
    })();
    decodedCache.set(key, p);
    p.catch(() => decodedCache.delete(key));
    return p;
  }

  function playWordWebAudio(word, acc) {
    getWordBuffer(word, acc).then((buf) => {
      if (activeSource) { try { activeSource.stop(); } catch (e) { /* ignore */ } }
      const node = audioCtx.createBufferSource();
      node.buffer = buf;
      node.connect(audioCtx.destination);
      activeSource = node;
      node.start();
    }).catch(() => playWordElement(word, acc));
  }

  // file:// 回退：<audio> 元素直读 words/ 目录
  const audioCache = new Map();
  let activeAudio = null;

  function playWordElement(word, acc) {
    const src = 'words/' + encodeURIComponent(word) + '_' + acc + '.mp3';
    let audio = audioCache.get(src);
    if (!audio) {
      audio = new Audio(src);
      audio.preload = 'auto';
      audio.addEventListener('error', () => {
        if (!audio._ttsTried) {
          audio._ttsTried = true;
          speakWord(word, acc);
        }
      });
      audioCache.set(src, audio);
    }
    audio._ttsTried = false;

    if (activeAudio && activeAudio !== audio) {
      try { activeAudio.pause(); } catch (e) { /* ignore */ }
    }
    activeAudio = audio;

    const doPlay = () => {
      try { audio.currentTime = 0; } catch (e) { /* ignore */ }
      const p = audio.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          if (!audio._ttsTried) {
            audio._ttsTried = true;
            speakWord(word, acc);
          }
        });
      }
    };

    // 等 canplay（HAVE_FUTURE_DATA）再播，避免只加载到首帧就播导致断续
    if (audio.readyState >= 3) {
      doPlay();
    } else {
      audio.addEventListener('canplay', doPlay, { once: true });
      audio.load();
    }
  }

  function wordCn(word) {
    const dict = window.WORD_CN;
    if (!dict || !word) return '';
    return dict[String(word).toLowerCase()] || '';
  }

  function playWord(word, accent) {
    if (!word) return;
    const acc = accent === 'uk' ? 'uk' : 'us';
    accentPref = acc;
    flashAccent(acc);
    playWordWebAudio(word, acc); // 失败时内部自动回退 playWordElement → TTS
  }

  function speakWord(word, accent) {
    if (!window.speechSynthesis) return;
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(String(word).replace(/-/g, ' '));
      utter.lang = accent === 'uk' ? 'en-GB' : 'en-US';
      utter.rate = 0.85;
      const voices = window.speechSynthesis.getVoices();
      const match = voices.find((v) => v.lang === utter.lang) ||
        voices.find((v) => String(v.lang).toLowerCase().startsWith('en'));
      if (match) utter.voice = match;
      window.speechSynthesis.speak(utter);
    } catch (e) { /* ignore */ }
  }

  function flashAccent(acc) {
    document.querySelectorAll('.accent-btn[data-accent="' + acc + '"]').forEach((btn) => {
      btn.classList.add('is-playing');
      setTimeout(() => btn.classList.remove('is-playing'), 700);
    });
  }

  function stopAudio() {
    if (activeAudio) {
      try { activeAudio.pause(); } catch (e) { /* ignore */ }
    }
    if (window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    }
  }

  /* ---------------- 浮层 ---------------- */
  function showOverlay(opts) {
    ovEyebrow.textContent = opts.eyebrow || '';
    ovTitle.textContent = opts.title || '';
    ovDesc.textContent = opts.desc || '';
    ovPrimary.textContent = opts.primaryText || '再来一局';
    ovPrimary.disabled = false;
    ovSecondary.textContent = opts.secondaryText || '返回';
    ovPrimary.onclick = opts.onPrimary || hideOverlay;
    ovSecondary.onclick = opts.onSecondary || hideOverlay;
    overlay.hidden = false;
  }

  function hideOverlay() {
    overlay.hidden = true;
    ovPrimary.onclick = null;
    ovSecondary.onclick = null;
  }

  /* ============================================================
     单机模式
     ============================================================ */
  const solo = {
    hearts: TOTAL_HEARTS,
    correct: 0,
    streak: 0,
    best: 0,
    index: 0,
    word: '',
    locked: false,
    timer: null
  };

  let soloBag = [];
  let soloLastWord = '';

  function drawSoloWord() {
    if (!soloBag.length) {
      soloBag = shuffle(WORDS);
      if (soloBag.length > 1 && soloBag[soloBag.length - 1] === soloLastWord) {
        [soloBag[0], soloBag[soloBag.length - 1]] = [soloBag[soloBag.length - 1], soloBag[0]];
      }
    }
    const word = soloBag.pop();
    soloLastWord = word;
    return word;
  }

  function renderSoloStats(breakingIndex) {
    soloCorrectEl.textContent = String(solo.correct);
    soloStreakEl.textContent = String(solo.streak);

    let html = '';
    for (let i = 0; i < TOTAL_HEARTS; i++) {
      const lost = i >= solo.hearts;
      const breaking = lost && i === breakingIndex;
      html += '<svg class="heart' + (lost ? ' is-lost' : '') + (breaking ? ' is-breaking' : '') +
        '" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
        '<path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>' +
        '</svg>';
    }
    soloHeartsEl.innerHTML = html;
  }

  function startSolo() {
    clearTimeout(solo.timer);
    solo.hearts = TOTAL_HEARTS;
    solo.correct = 0;
    solo.streak = 0;
    solo.best = 0;
    solo.index = 0;
    solo.locked = false;
    soloBag = [];
    soloLastWord = '';
    renderSoloStats();
    hideOverlay();
    showScreen('screenSolo');
    nextSoloWord();
  }

  function nextSoloWord() {
    solo.word = drawSoloWord();
    solo.index += 1;
    solo.locked = false;
    soloInput.value = '';
    soloInput.disabled = false;
    soloSubmit.disabled = false;
    soloIndex.textContent = '第 ' + solo.index + ' 题';
    soloFeedback.className = 'feedback';
    soloFeedback.textContent = '按回车提交，答错扣 1 滴血';
    if (isFinePointer()) soloInput.focus();
    playWord(solo.word, accentPref);
  }

  function submitSolo(event) {
    event.preventDefault();
    if (solo.locked) return;
    const value = soloInput.value.trim();
    if (!value) {
      if (isFinePointer()) soloInput.focus();
      return;
    }

    if (isSameSpelling(value, solo.word)) {
      solo.correct += 1;
      solo.streak += 1;
      solo.best = Math.max(solo.best, solo.streak);
      solo.locked = true;
      soloInput.disabled = true;
      soloSubmit.disabled = true;
      soloFeedback.className = 'feedback ok';
      const okCn = wordCn(solo.word);
      soloFeedback.innerHTML = '✓ 正确！' + (solo.streak > 1 ? '连击 x' + solo.streak + ' · ' : '')
        + '<span class="spell">' + esc(solo.word) + '</span>'
        + (okCn ? '<span class="cn">' + esc(okCn) + '</span>' : '');
      renderSoloStats();
      solo.timer = setTimeout(() => {
        if (activeScreenId === 'screenSolo') nextSoloWord();
      }, 1600);
      return;
    }

    solo.hearts -= 1;
    solo.streak = 0;
    solo.locked = true;
    soloInput.disabled = true;
    soloSubmit.disabled = true;
    renderSoloStats(solo.hearts);
    soloFeedback.className = 'feedback answer-reveal';
    const badCn = wordCn(solo.word);
    soloFeedback.innerHTML = '正确答案：<span class="spell">' + esc(solo.word) + '</span>'
      + (badCn ? '<span class="cn">' + esc(badCn) + '</span>' : '');
    const dead = solo.hearts <= 0;
    solo.timer = setTimeout(() => {
      if (activeScreenId !== 'screenSolo') return;
      if (dead) showSoloEnd();
      else nextSoloWord();
    }, 2400);
  }

  function showSoloEnd() {
    showOverlay({
      eyebrow: 'SOLO RUN OVER',
      title: '闯关结束',
      desc: '共答对 ' + solo.correct + ' 题 · 最高连击 ' + solo.best,
      primaryText: '再来一局',
      onPrimary: () => { hideOverlay(); startSolo(); },
      secondaryText: '返回首页',
      onSecondary: () => { hideOverlay(); showScreen('screenHome'); }
    });
  }

  /* ============================================================
     MQTT 联机
     ============================================================ */
  const net = {
    client: null,
    role: null,            // 'host' | 'guest'
    room: null,
    name: '',
    connected: false,
    joined: false,
    myId: (() => {
      try {
        const key = 'spellrush.uid';
        let id = sessionStorage.getItem(key);
        if (!id) {
          id = 'u' + Math.random().toString(36).slice(2, 10);
          sessionStorage.setItem(key, id);
        }
        return id;
      } catch (e) {
        return 'u' + Math.random().toString(36).slice(2, 10);
      }
    })(),
    state: null,
    stateAt: 0,
    lastStateAt: 0,
    hostGame: null,
    audioKey: '',
    submittedKey: '',
    finishedShown: false,
    joinTimer: null,
    hostLoop: null,
    lastPresenceSent: 0,
    lastJoinSent: 0,
    hostPublishAt: 0,
    hostStale: false,
    lostOverlayShown: false,
    justEnabled: false
  };

  const lastScores = { host: 0, guest: 0 };

  function setNetStatus(stateName, text) {
    netStatusEl.dataset.state = stateName;
    netText.textContent = text;
  }

  function ensureClient() {
    if (net.client) {
      if (!net.connected) setNetStatus('connecting', '连接中…');
      return net.client;
    }
    if (typeof window.mqtt === 'undefined') {
      setNetStatus('offline', 'MQTT 加载失败');
      return null;
    }
    setNetStatus('connecting', '连接中…');
    const client = window.mqtt.connect(BROKER, {
      clientId: 'spellrush_' + Math.random().toString(16).slice(2, 10),
      clean: true,
      reconnectPeriod: 2500,
      connectTimeout: 8000,
      keepalive: 30
    });
    net.client = client;

    client.on('connect', () => {
      net.connected = true;
      setNetStatus('online', '联机已连接');
      if (net.role === 'host') {
        setupHostSubs();
        publishHostState(true);
      } else if (net.role === 'guest') {
        subscribeStateTopic();
        if (net.room) sendJoin();
      }
    });

    client.on('reconnect', () => setNetStatus('connecting', '重新连接…'));
    client.on('close', () => {
      net.connected = false;
      setNetStatus('offline', '连接已断开');
    });
    client.on('error', () => {
      setNetStatus('offline', '连接异常');
    });
    client.on('message', onNetMessage);
    return client;
  }

  function topicOf(suffix) {
    return ROOT + net.room + '/' + suffix;
  }

  function setupHostSubs() {
    if (!net.client || !net.room) return;
    net.client.subscribe([topicOf('j'), topicOf('a'), topicOf('p')], { qos: 0 });
  }

  function subscribeStateTopic() {
    if (!net.client || !net.room) return;
    net.client.subscribe(topicOf('s'), { qos: 0 });
  }

  function publishTo(suffix, payload) {
    if (!net.client || !net.connected || !net.room) return;
    net.client.publish(topicOf(suffix), JSON.stringify(payload), { qos: 0 });
  }

  function sendJoin() {
    net.lastJoinSent = Date.now();
    publishTo('j', { t: 'join', id: net.myId, name: net.name || '玩家' });
  }

  function onNetMessage(topic, payload) {
    if (!net.room || !net.role) return;
    let msg = null;
    try {
      msg = JSON.parse(payload.toString());
    } catch (e) {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (net.role === 'guest') {
      if (topic === topicOf('s')) onGuestState(msg);
      return;
    }

    if (topic === topicOf('j')) onHostJoin(msg);
    else if (topic === topicOf('a')) onHostAnswer(msg);
    else if (topic === topicOf('p')) onHostPresence(msg);
  }

  /* ---------------- 房间码 ---------------- */
  function genRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 5; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }

  function loadName() {
    try {
      return localStorage.getItem('spellrush.name') || '';
    } catch (e) {
      return '';
    }
  }

  function saveName(name) {
    try { localStorage.setItem('spellrush.name', name); } catch (e) { /* ignore */ }
  }

  function readName() {
    const name = cleanName(nameInput.value);
    if (!name) {
      setLobbyTip('先给自己起个昵称吧', true);
      nameInput.focus();
      return '';
    }
    saveName(name);
    setLobbyTip('', false);
    return name;
  }

  function setLobbyTip(text, isError) {
    lobbyTip.textContent = text;
    lobbyTip.classList.toggle('is-error', !!isError);
  }

  /* ---------------- 大厅动作 ---------------- */
  function createRoom() {
    const name = readName();
    if (!name) return;

    leaveRoom(false);
    net.name = name;
    net.role = 'host';
    net.room = genRoomCode();
    net.joined = true;
    net.hostGame = newHostGame();
    net.finishedShown = false;
    net.lostOverlayShown = false;

    ensureClient();
    if (net.connected) {
      setupHostSubs();
    }
    startHostLoop();
    publishHostState(true);

    showRoomBox();
    showScreen('screenLobby');
    renderLobbyFromState(buildSnapshot(net.hostGame));
  }

  function joinRoom() {
    const name = readName();
    if (!name) return;
    const code = String(roomInput.value || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,6}$/.test(code)) {
      setLobbyTip('请输入正确的房间码', true);
      roomInput.focus();
      return;
    }

    leaveRoom(false);
    net.name = name;
    net.role = 'guest';
    net.room = code;
    net.joined = false;
    net.state = null;
    net.lastStateAt = 0;
    net.lostOverlayShown = false;

    ensureClient();
    if (net.connected) {
      subscribeStateTopic();
      sendJoin();
    }

    roomCodeText.textContent = code;
    roomStatus.textContent = '正在加入房间…';
    roomStatus.classList.remove('ok');
    rpMeName.textContent = name;
    rpOppName.textContent = '等待中…';
    rpOpp.classList.remove('is-ready');
    btnHostStart.hidden = true;
    lobbyEntry.hidden = true;
    roomBox.hidden = false;
    showScreen('screenLobby');

    clearTimeout(net.joinTimer);
    net.joinTimer = setTimeout(() => {
      if (net.joined || net.role !== 'guest') return;
      leaveRoom(false);
      setLobbyTip('房间不存在或房主已离线，请检查房间码', true);
      showScreen('screenLobby');
    }, 12000);
  }

  function showRoomBox() {
    lobbyEntry.hidden = true;
    roomBox.hidden = false;
    roomCodeText.textContent = net.room || '-----';
    rpMeName.textContent = net.name || '你';
    btnHostStart.hidden = net.role !== 'host';
    btnHostStart.disabled = true;
  }

  function leaveRoom(goHome) {
    clearTimeout(net.joinTimer);
    if (net.hostLoop) {
      clearInterval(net.hostLoop);
      net.hostLoop = null;
    }

    if (net.client && net.room) {
      try {
        if (net.role === 'guest' && net.connected) {
          net.client.publish(topicOf('j'), JSON.stringify({ t: 'leave', id: net.myId }), { qos: 0 });
        } else if (net.role === 'host' && net.connected) {
          net.client.publish(topicOf('s'), JSON.stringify({ v: 1, phase: 'closed', hostName: net.name }), { qos: 0, retain: true });
        }
        net.client.unsubscribe([topicOf('s'), topicOf('j'), topicOf('a'), topicOf('p')]);
      } catch (e) { /* ignore */ }
    }

    stopAudio();
    net.role = null;
    net.room = null;
    net.joined = false;
    net.state = null;
    net.hostGame = null;
    net.audioKey = '';
    net.submittedKey = '';
    net.finishedShown = false;
    net.hostStale = false;
    net.lostOverlayShown = false;

    lobbyEntry.hidden = false;
    roomBox.hidden = true;
    btnHostStart.disabled = true;
    multiInput.value = '';
    multiInput.disabled = true;
    multiSubmit.disabled = true;
    hideOverlay();
    if (goHome) showScreen('screenHome');
  }

  function copyRoomCode() {
    const code = net.room || roomCodeText.textContent;
    const done = () => {
      btnCopyRoom.textContent = '已复制';
      setTimeout(() => { btnCopyRoom.textContent = '复制'; }, 1500);
    };
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = code;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      btnCopyRoom.textContent = ok ? '已复制' : '复制失败';
      setTimeout(() => { btnCopyRoom.textContent = '复制'; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(done).catch(fallback);
    } else {
      fallback();
    }
  }

  /* ---------------- 主机权威状态 ---------------- */
  function newHostGame() {
    return {
      phase: 'waiting',
      hostName: net.name || '房主',
      guestName: '',
      guestId: '',
      guestConnected: false,
      scores: { host: 0, guest: 0 },
      word: '',
      wordNumber: 0,
      attempt: 1,
      turn: 'host',
      deadline: 0,
      reveal: null,
      revealUntil: 0,
      countdownUntil: 0,
      winner: null,
      finishReason: '',
      pendingFinish: null,
      bag: shuffle(WORDS),
      lastPresence: 0
    };
  }

  function buildSnapshot(g) {
    const now = Date.now();
    return {
      v: 1,
      phase: g.phase,
      hostName: g.hostName,
      guestName: g.guestName,
      guestId: g.guestId,
      guestConnected: g.guestConnected,
      scores: { host: g.scores.host, guest: g.scores.guest },
      word: g.word,
      wordNumber: g.wordNumber,
      attempt: g.attempt,
      turn: g.turn,
      remainingMs: g.phase === 'playing' ? Math.max(0, g.deadline - now) : 0,
      countdownMs: g.phase === 'countdown' ? Math.max(0, g.countdownUntil - now) : 0,
      reveal: g.reveal,
      winner: g.winner,
      finishReason: g.finishReason,
      maxWords: MAX_WORDS,
      target: MATCH_TARGET,
      roundPoints: ROUND_POINTS,
      sentAt: now
    };
  }

  function publishHostState(retain) {
    const g = net.hostGame;
    if (!g) return;
    const snap = buildSnapshot(g);
    net.state = snap;
    net.stateAt = Date.now();
    if (net.client && net.connected && net.room && net.role === 'host') {
      net.client.publish(topicOf('s'), JSON.stringify(snap), { qos: 0, retain: !!retain });
    }
    renderMulti();
  }

  function startHostLoop() {
    if (net.hostLoop) clearInterval(net.hostLoop);
    net.hostLoop = setInterval(hostTick, 250);
  }

  function hostTick() {
    const g = net.hostGame;
    if (!g || net.role !== 'host') return;
    const now = Date.now();

    if (g.phase === 'countdown') {
      if (now >= g.countdownUntil) { beginWord(); return; }
    } else if (g.phase === 'playing') {
      if (now >= g.deadline) { hostResolve(g.turn, '', true); return; }
    } else if (g.phase === 'reveal') {
      if (now >= g.revealUntil) { afterReveal(); return; }
    }

    if (g.guestConnected && now - net.hostPublishAt >= 500) {
      net.hostPublishAt = now;
      publishHostState(false);
    }
  }

  function hostStartMatch() {
    const g = net.hostGame;
    if (!g || !g.guestConnected) return;
    g.scores = { host: 0, guest: 0 };
    g.word = '';
    g.wordNumber = 0;
    g.attempt = 1;
    g.turn = 'host';
    g.reveal = null;
    g.winner = null;
    g.finishReason = '';
    g.pendingFinish = null;
    g.bag = shuffle(WORDS);
    g.phase = 'countdown';
    g.countdownUntil = Date.now() + COUNTDOWN_MS;
    net.audioKey = '';
    net.submittedKey = '';
    net.finishedShown = false;
    lastScores.host = 0;
    lastScores.guest = 0;
    hideOverlay();
    showScreen('screenMulti');
    publishHostState(true);
  }

  function beginWord() {
    const g = net.hostGame;
    if (!g) return;
    if (!g.bag || !g.bag.length) g.bag = shuffle(WORDS);
    g.word = g.bag.pop();
    g.wordNumber += 1;
    g.attempt = 1;
    g.turn = g.wordNumber % 2 === 1 ? 'host' : 'guest';
    g.phase = 'playing';
    g.reveal = null;
    g.deadline = Date.now() + ROUND_TIME;
    g.pendingFinish = null;
    publishHostState(true);
  }

  function hostResolve(by, text, isTimeout) {
    const g = net.hostGame;
    if (!g || g.phase !== 'playing' || g.turn !== by) return;
    if (!isTimeout && Date.now() > g.deadline + 1200) return;

    const correct = !isTimeout && isSameSpelling(text, g.word);

    if (correct) {
      const points = ROUND_POINTS[Math.min(g.attempt, MAX_ROUNDS) - 1];
      g.scores[by] += points;
      if (g.scores[by] >= MATCH_TARGET) g.pendingFinish = by;
      g.reveal = {
        kind: 'correct',
        answer: g.word,
        word: g.word,
        by: by,
        scorer: by,
        points: points,
        attempt: g.attempt,
        timeout: false
      };
      g.phase = 'reveal';
      g.revealUntil = Date.now() + REVEAL_MS.correct;
    } else {
      const willSwitch = g.attempt < MAX_ROUNDS;
      g.reveal = {
        kind: willSwitch ? 'wrong' : 'none',
        answer: g.word,
        word: g.word,
        by: by,
        scorer: null,
        points: 0,
        attempt: g.attempt,
        timeout: !!isTimeout
      };
      g.phase = 'reveal';
      g.revealUntil = Date.now() + (willSwitch ? REVEAL_MS.wrong : REVEAL_MS.none);
    }

    publishHostState(true);
  }

  function afterReveal() {
    const g = net.hostGame;
    if (!g) return;
    const r = g.reveal;

    if (r && r.kind === 'wrong') {
      g.attempt = Math.min(MAX_ROUNDS, r.attempt + 1);
      g.turn = r.by === 'host' ? 'guest' : 'host';
      g.phase = 'playing';
      g.reveal = null;
      g.deadline = Date.now() + ROUND_TIME;
      publishHostState(true);
      return;
    }

    if (g.pendingFinish || g.wordNumber >= MAX_WORDS) {
      finishMatch();
      return;
    }
    beginWord();
  }

  function finishMatch() {
    const g = net.hostGame;
    const hostScore = g.scores.host;
    const guestScore = g.scores.guest;
    g.winner = hostScore === guestScore ? 'draw' : (hostScore > guestScore ? 'host' : 'guest');
    g.finishReason = g.pendingFinish ? 'target' : 'words';
    g.phase = 'finished';
    g.reveal = null;
    g.pendingFinish = null;
    net.finishedShown = false;
    publishHostState(true);
    renderMulti();
  }

  function resetMatchData(g) {
    g.scores = { host: 0, guest: 0 };
    g.word = '';
    g.wordNumber = 0;
    g.attempt = 1;
    g.turn = 'host';
    g.reveal = null;
    g.winner = null;
    g.finishReason = '';
    g.pendingFinish = null;
    g.phase = 'waiting';
  }

  function loseGuest() {
    const g = net.hostGame;
    if (!g) return;
    g.guestConnected = false;
    g.guestId = '';
    g.guestName = '';
    g.lastPresence = 0;
    resetMatchData(g);
    net.finishedShown = false;
    net.audioKey = '';
    hideOverlay();
    publishHostState(true);
    showScreen('screenLobby');
  }

  function onHostJoin(msg) {
    const g = net.hostGame;
    if (!g || !msg.id) return;

    if (msg.t === 'join') {
      if (g.guestConnected && g.guestId && g.guestId !== msg.id) {
        publishHostState(true);
        return;
      }
      g.guestId = msg.id;
      g.guestName = cleanName(msg.name) || '对手';
      g.guestConnected = true;
      g.lastPresence = Date.now();

      if (g.phase === 'waiting' || g.phase === 'finished') {
        resetMatchData(g);
        g.phase = 'ready';
        net.finishedShown = false;
      } else if (g.phase === 'ready') {
        /* 已在等待开局 */
      }

      publishHostState(true);
      renderMulti();
      return;
    }

    if (msg.t === 'leave') {
      if (g.guestId === msg.id) {
        g.guestConnected = false;
        g.guestId = '';
        g.guestName = '';
        g.lastPresence = 0;
        resetMatchData(g);
        net.finishedShown = false;
        net.audioKey = '';
        hideOverlay();
        publishHostState(true);
        showScreen('screenLobby');
      }
      return;
    }

    if (msg.t === 'rematch') {
      if (g.guestId === msg.id && g.phase === 'finished' && g.guestConnected) {
        hostStartMatch();
      }
    }
  }

  function onHostAnswer(msg) {
    const g = net.hostGame;
    if (!g || msg.t !== 'answer') return;
    if (msg.id !== g.guestId) return;
    if (g.phase !== 'playing' || g.turn !== 'guest') return;
    if (msg.wordNumber !== g.wordNumber || msg.attempt !== g.attempt) return;
    hostResolve('guest', String(msg.text || ''), false);
  }

  function onHostPresence(msg) {
    const g = net.hostGame;
    if (!g || !msg.id) return;
    if (g.guestId === msg.id && g.guestConnected) {
      g.lastPresence = Date.now();
    }
  }

  /* ---------------- 客机 ---------------- */
  function onGuestState(s) {
    if (!s || typeof s !== 'object') return;

    if (s.phase === 'closed') {
      if (net.joined || net.role === 'guest') {
        leaveRoom(false);
        setLobbyTip('房主已关闭房间', true);
        showOverlay({
          eyebrow: 'ROOM CLOSED',
          title: '房主已离开',
          desc: '这个房间已经关闭了，回大厅开一局新的吧。',
          primaryText: '返回大厅',
          onPrimary: () => { hideOverlay(); leaveRoom(true); }
        });
      }
      return;
    }

    if (s.guestId !== net.myId) {
      if (s.guestId && s.guestConnected && !net.joined) {
        clearTimeout(net.joinTimer);
        leaveRoom(false);
        setLobbyTip('房间已满，换一个房间码试试', true);
        showScreen('screenLobby');
        return;
      }
      if (net.joined) {
        leaveRoom(false);
        setLobbyTip('房主已重置房间，请重新加入', true);
        showScreen('screenLobby');
        return;
      }
      return;
    }

    net.lastStateAt = Date.now();
    net.stateAt = Date.now();
    net.state = s;
    net.hostStale = false;

    if (!net.joined) {
      net.joined = true;
      clearTimeout(net.joinTimer);
      net.name = s.guestName || net.name;
      showRoomBox();
      btnHostStart.hidden = true;
    }

    if (s.phase !== 'finished') net.finishedShown = false;
    if (s.phase === 'countdown') {
      hideOverlay();
      net.audioKey = '';
      net.submittedKey = '';
    }

    renderMulti();
  }

  function submitMulti(event) {
    event.preventDefault();
    const s = net.state;
    if (!s || s.phase !== 'playing') return;
    if (s.turn !== net.role) return;
    const text = multiInput.value.trim();
    if (!text) {
      if (isFinePointer()) multiInput.focus();
      return;
    }

    if (net.role === 'host') {
      hostResolve('host', text, false);
      multiInput.value = '';
      return;
    }

    if (!net.client || !net.connected) {
      multiFeedback.className = 'feedback bad';
      multiFeedback.textContent = '连接已断开，正在重连…';
      return;
    }

    publishTo('a', {
      t: 'answer',
      id: net.myId,
      wordNumber: s.wordNumber,
      attempt: s.attempt,
      text: text
    });
    net.submittedKey = s.wordNumber + ':' + s.attempt;
    multiInput.value = '';
    multiInput.disabled = true;
    multiSubmit.disabled = true;
    renderMulti();
  }

  function showMultiResult(s) {
    if (net.finishedShown) return;
    net.finishedShown = true;

    const myRole = net.role;
    const oppRole = myRole === 'host' ? 'guest' : 'host';
    const mine = s.scores[myRole] || 0;
    const theirs = s.scores[oppRole] || 0;
    const title = s.winner === 'draw' ? '平局' : (s.winner === myRole ? '你赢了' : '惜败');
    const reason = s.finishReason === 'target'
      ? '率先达到 ' + s.target + ' 分'
      : '打满 ' + s.maxWords + ' 个词';
    const isHost = net.role === 'host';

    showOverlay({
      eyebrow: 'MATCH OVER',
      title: title,
      desc: reason + ' · 比分 ' + mine + ' : ' + theirs,
      primaryText: isHost ? '再来一局' : '请求再来一局',
      onPrimary: isHost
        ? () => { hideOverlay(); hostStartMatch(); }
        : () => {
            publishTo('j', { t: 'rematch', id: net.myId });
            ovPrimary.disabled = true;
            ovPrimary.textContent = '已请求，等待房主…';
          },
      secondaryText: '离开房间',
      onSecondary: () => { hideOverlay(); leaveRoom(true); }
    });
  }

  /* ---------------- 渲染 ---------------- */
  function renderLobbyFromState(s) {
    showScreen('screenLobby');
    lobbyEntry.hidden = true;
    roomBox.hidden = false;
    roomCodeText.textContent = net.room || '-----';

    const isHost = net.role === 'host';
    const oppConnected = !!s.guestConnected;
    const oppName = isHost ? s.guestName : s.hostName;

    rpMeName.textContent = net.name || (isHost ? '房主' : '你');
    rpOppName.textContent = oppConnected && oppName ? oppName : '等待中…';
    rpOpp.classList.toggle('is-ready', oppConnected);

    btnHostStart.hidden = !isHost;
    btnHostStart.disabled = !(isHost && oppConnected);

    if (isHost) {
      if (s.phase === 'ready') {
        roomStatus.textContent = '对手已加入，随时开战';
        roomStatus.classList.add('ok');
      } else {
        roomStatus.textContent = '等待对手加入…';
        roomStatus.classList.remove('ok');
      }
    } else {
      roomStatus.textContent = s.phase === 'ready'
        ? '已加入，等待房主开始对战'
        : '已加入房间，等待房主…';
      roomStatus.classList.add('ok');
    }
  }

  function bumpScore(el) {
    el.classList.remove('is-bump');
    void el.offsetWidth;
    el.classList.add('is-bump');
    setTimeout(() => el.classList.remove('is-bump'), 500);
  }

  function renderMulti() {
    const s = net.state;
    if (!s || !net.role) return;
    if (net.role === 'guest' && !net.joined) return;

    if (!['countdown', 'playing', 'reveal', 'finished'].includes(s.phase)) {
      renderLobbyFromState(s);
      return;
    }

    showScreen('screenMulti');

    const isHost = net.role === 'host';
    const myRole = isHost ? 'host' : 'guest';
    const oppRole = isHost ? 'guest' : 'host';
    const myName = isHost ? (s.hostName || net.name) : (s.guestName || net.name);
    const oppName = isHost ? (s.guestName || '对手') : (s.hostName || '对手');
    const myScore = s.scores[myRole] || 0;
    const oppScore = s.scores[oppRole] || 0;

    meNameEl.textContent = myName + '（你）';
    oppNameEl.textContent = oppName;
    meScoreEl.textContent = String(myScore);
    oppScoreEl.textContent = String(oppScore);

    if (lastScores[myRole] !== myScore) {
      lastScores[myRole] = myScore;
      bumpScore(meScoreEl);
    }
    if (lastScores[oppRole] !== oppScore) {
      lastScores[oppRole] = oppScore;
      bumpScore(oppScoreEl);
    }

    const shownAttempt = Math.min(Math.max(s.attempt, 1), MAX_ROUNDS);
    const shownPoints = ROUND_POINTS[shownAttempt - 1];
    wordNoEl.textContent = '#' + (s.wordNumber || 0);
    multiMatchMeta.textContent = '第 ' + (s.wordNumber || 0) + ' / ' + s.maxWords + ' 词 · 先到 ' + s.target + ' 分';
    multiRound.textContent = '第 ' + shownAttempt + ' 轮';
    multiPoints.textContent = '答对 +' + shownPoints;
    multiWords.textContent = '词 ' + (s.wordNumber || 0) + ' / ' + s.maxWords;

    const activeTurn = s.phase === 'playing' && s.turn === myRole;
    cardMe.classList.toggle('is-active', activeTurn);
    cardOpp.classList.toggle('is-active', s.phase === 'playing' && s.turn === oppRole);
    cardMe.querySelector('.turn-flag').textContent = '你的回合';
    cardOpp.querySelector('.turn-flag').textContent = '对手回合';

    const submitted = net.submittedKey === s.wordNumber + ':' + s.attempt;
    const connectedOk = isHost ? true : (net.connected && !net.hostStale);
    const canAnswer = s.phase === 'playing' && s.turn === myRole && !submitted && connectedOk;

    multiInput.disabled = !canAnswer;
    multiSubmit.disabled = !canAnswer;
    if (canAnswer && document.activeElement !== multiInput && isFinePointer() && net.justEnabled !== true) {
      net.justEnabled = true;
      multiInput.focus();
    }
    if (!canAnswer) net.justEnabled = false;

    if (s.phase === 'playing') {
      const key = s.wordNumber + ':' + s.attempt;
      if (net.audioKey !== key) {
        net.audioKey = key;
        playWord(s.word, accentPref);
      }
    }

    let fbClass = 'feedback';
    let fbText = '';
    if (s.phase === 'countdown') {
      fbText = '对战即将开始…';
    } else if (s.phase === 'playing') {
      if (submitted) fbText = '已提交，等待判定…';
      else if (activeTurn) fbText = '你的回合 · 30 秒内拼出单词';
      else fbText = '等待 ' + esc(oppName) + ' 作答…';
    } else if (s.phase === 'reveal' && s.reveal) {
      const r = s.reveal;
      const rCn = wordCn(r.answer);
      const cnHtml = rCn ? '<span class="cn">' + esc(rCn) + '</span>' : '';
      if (r.kind === 'correct') {
        fbClass = 'feedback ok';
        const isMe = r.scorer === myRole;
        fbText = (isMe ? '你' : esc(oppName)) + ' 答对 +' + r.points + ' 分 · <span class="spell">' + esc(r.answer) + '</span>' + cnHtml;
      } else if (r.kind === 'wrong') {
        fbClass = 'feedback bad';
        const byMe = r.by === myRole;
        // 换人不换词，不公布答案和释义，避免给下一位玩家提示
        fbText = (byMe ? '你' : esc(oppName)) + ' 答错了，轮到' + (byMe ? ' ' + esc(oppName) : '你') + '（第 ' + (r.attempt + 1) + ' 轮）';
      } else {
        fbClass = 'feedback answer-reveal';
        fbText = '正确答案：<span class="spell">' + esc(r.answer) + '</span> · 本题无效' + cnHtml;
      }
    } else if (s.phase === 'finished') {
      fbText = '对局结束';
    }

    if (net.hostStale && !isHost) {
      fbClass = 'feedback bad';
      fbText = '与房主连接中断，正在重连…';
    }

    multiFeedback.className = fbClass;
    multiFeedback.innerHTML = fbText;

    if (s.phase === 'finished') {
      showMultiResult(s);
    }
  }

  function updateTimerUI() {
    if (activeScreenId !== 'screenMulti') return;
    const s = net.state;
    if (!s) return;

    const elapsed = Date.now() - net.stateAt;
    let total = ROUND_TIME;
    let remaining = 0;

    if (s.phase === 'playing') {
      remaining = Math.max(0, (s.remainingMs || 0) - elapsed);
    } else if (s.phase === 'countdown') {
      total = COUNTDOWN_MS;
      remaining = Math.max(0, (s.countdownMs || 0) - elapsed);
    }

    const pct = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
    timerFill.style.width = (pct * 100).toFixed(1) + '%';

    const secs = Math.ceil(remaining / 1000);
    if (s.phase === 'playing') {
      timerNum.textContent = String(secs);
      timerBar.classList.toggle('is-low', remaining <= 8000);
    } else if (s.phase === 'countdown') {
      timerNum.textContent = String(Math.max(1, secs));
      timerBar.classList.remove('is-low');
      multiFeedback.className = 'feedback';
      multiFeedback.textContent = '对战即将开始 · ' + Math.max(1, secs);
    } else {
      timerNum.textContent = '0';
      timerBar.classList.remove('is-low');
    }
  }

  /* ---------------- 心跳 / 看门狗 ---------------- */
  function netTick() {
    const now = Date.now();

    if (net.role === 'guest' && net.joined) {
      if (net.connected && now - net.lastPresenceSent >= PRESENCE_EVERY) {
        net.lastPresenceSent = now;
        publishTo('p', { t: 'p', id: net.myId, name: net.name });
      }
      if (net.state && net.lastStateAt && now - net.lastStateAt > HOST_TIMEOUT) {
        net.hostStale = true;
        if (now - net.lastStateAt > HOST_TIMEOUT + 6000 && !net.lostOverlayShown && overlay.hidden) {
          net.lostOverlayShown = true;
          showOverlay({
            eyebrow: 'CONNECTION LOST',
            title: '与房主断开连接',
            desc: '房间长时间没有响应，可能是房主关闭了页面。',
            primaryText: '返回大厅',
            onPrimary: () => { hideOverlay(); leaveRoom(true); }
          });
        }
      } else if (!net.state || now - net.lastStateAt <= HOST_TIMEOUT) {
        net.hostStale = false;
      }
    }

    if (net.role === 'guest' && !net.joined && net.room) {
      if (net.connected && now - net.lastJoinSent >= 2000) {
        sendJoin();
      }
    }

    if (net.role === 'host' && net.hostGame) {
      const g = net.hostGame;
      if (g.guestConnected && g.lastPresence && now - g.lastPresence > GUEST_TIMEOUT) {
        loseGuest();
      }
    }
  }

  function uiTick() {
    updateTimerUI();
  }

  /* ============================================================
     事件绑定
     ============================================================ */
  function bindEvents() {
    btnSolo.addEventListener('click', startSolo);
    btnMulti.addEventListener('click', () => {
      showScreen('screenLobby');
      lobbyEntry.hidden = false;
      roomBox.hidden = true;
      setLobbyTip('创建房间后，把 5 位房间码发给朋友即可开战', false);
      ensureClient();
      if (isFinePointer()) nameInput.focus();
    });

    $('btnSoloBack').addEventListener('click', () => {
      clearTimeout(solo.timer);
      stopAudio();
      showScreen('screenHome');
    });
    $('btnLobbyBack').addEventListener('click', () => {
      if (net.role) leaveRoom(true);
      else showScreen('screenHome');
    });

    soloForm.addEventListener('submit', submitSolo);
    soloPlayUk.addEventListener('click', () => playWord(solo.word, 'uk'));
    soloPlayUs.addEventListener('click', () => playWord(solo.word, 'us'));

    btnCreate.addEventListener('click', createRoom);
    btnJoin.addEventListener('click', joinRoom);
    roomInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        joinRoom();
      }
    });
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !roomInput.value.trim()) {
        e.preventDefault();
        createRoom();
      }
    });
    btnCopyRoom.addEventListener('click', copyRoomCode);
    btnHostStart.addEventListener('click', hostStartMatch);
    btnLeaveRoom.addEventListener('click', () => leaveRoom(true));
    btnMultiLeave.addEventListener('click', () => leaveRoom(true));

    multiForm.addEventListener('submit', submitMulti);
    multiPlayUk.addEventListener('click', () => {
      if (net.state && net.state.word) playWord(net.state.word, 'uk');
    });
    multiPlayUs.addEventListener('click', () => {
      if (net.state && net.state.word) playWord(net.state.word, 'us');
    });

    window.addEventListener('beforeunload', () => {
      if (net.client && net.room) {
        try {
          if (net.role === 'host') {
            net.client.publish(topicOf('s'), JSON.stringify({ v: 1, phase: 'closed', hostName: net.name }), { qos: 0, retain: true });
          } else if (net.role === 'guest') {
            net.client.publish(topicOf('j'), JSON.stringify({ t: 'leave', id: net.myId }), { qos: 0 });
          }
        } catch (e) { /* ignore */ }
      }
    });
  }

  /* ============================================================
     启动
     ============================================================ */
  function boot() {
    if (!WORDS.length) {
      soloPool.textContent = '词库为空';
      setNetStatus('offline', '词库加载失败');
      return;
    }
    // 音频按需加载，无需预载，直接可玩
    if (location.protocol === 'file:') {
      setNetStatus('offline', '本地打开：建议用本地服务器获取完整音频');
    }
    nameInput.value = loadName();
    soloPool.textContent = WORDS.length + ' 词随机';
    bindEvents();
    renderSoloStats();
    setInterval(netTick, 1000);
    setInterval(uiTick, 100);
  }

  boot();
})();
