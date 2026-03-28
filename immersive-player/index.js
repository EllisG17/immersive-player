const react = Spicetify.React;
const {
  useState,
  useEffect,
  useCallback,
  useRef,
  createElement: h,
} = react;

const LS = "immersive-player:";

function readBool(key, def) {
  const v = localStorage.getItem(LS + key);
  if (v === null) return def;
  return v === "true";
}

function writeBool(key, val) {
  localStorage.setItem(LS + key, val ? "true" : "false");
}

function readStr(key, def) {
  return localStorage.getItem(LS + key) ?? def;
}

function writeStr(key, val) {
  localStorage.setItem(LS + key, val);
}

function readFloat(key, def) {
  const n = Number.parseFloat(localStorage.getItem(LS + key) ?? "");
  return Number.isFinite(n) ? n : def;
}

const LAYOUT_KEY = LS + "layout-v1";

const DEFAULT_LAYOUT_SPLIT = {
  media: { x: 3, y: 5, w: 44, h: 88 },
  lyrics: { x: 50, y: 5, w: 46, h: 62 },
  transport: { x: 50, y: 70, w: 46, h: 24 },
};

const DEFAULT_LAYOUT_VIDEOFULL = {
  media: { x: 0, y: 0, w: 100, h: 100 },
  lyrics: { x: 58, y: 4, w: 40, h: 72 },
  transport: { x: 58, y: 78, w: 40, h: 18 },
};

function clampRect(r) {
  const minW = 14;
  const minH = 10;
  let w = Math.max(minW, Math.min(100, r.w));
  let h = Math.max(minH, Math.min(100, r.h));
  let x = Math.max(0, Math.min(r.x, 100 - w));
  let y = Math.max(0, Math.min(r.y, 100 - h));
  if (x + w > 100) x = 100 - w;
  if (y + h > 100) y = 100 - h;
  return { x, y, w, h };
}

const LAYOUT_GRID_STEP_PCT = 5;

function snapRectToGrid(r, enabled) {
  if (!enabled) return r;
  const snap = (v) => Math.round(v / LAYOUT_GRID_STEP_PCT) * LAYOUT_GRID_STEP_PCT;
  return clampRect({
    x: snap(r.x),
    y: snap(r.y),
    w: Math.max(14, snap(r.w)),
    h: Math.max(10, snap(r.h)),
  });
}

function readLayout() {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object") return null;
    const { media, lyrics, transport } = j;
    if (
      ![media, lyrics, transport].every(
        (p) =>
          p &&
          typeof p.x === "number" &&
          typeof p.y === "number" &&
          typeof p.w === "number" &&
          typeof p.h === "number"
      )
    )
      return null;
    return {
      media: clampRect(media),
      lyrics: clampRect(lyrics),
      transport: clampRect(transport),
    };
  } catch {
    return null;
  }
}

function persistLayoutObj(layout) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch (_) {}
}

/** Leave the custom app view for the main Spotify Home browse screen */
function navigateToSpotifyHome() {
  try {
    const H = Spicetify.Platform?.History;
    if (!H) return;
    if (typeof H.replace === "function") {
      H.replace("/");
      return;
    }
    if (typeof H.push === "function") H.push("/");
  } catch (_) {}
}

function DragLayoutPanel({
  panelId,
  label,
  rect,
  z,
  editMode,
  onMoveStart,
  onResizeStart,
  flushBody,
  children,
}) {
  return h(
    "div",
    {
      className: "im-drag-panel" + (editMode ? " is-editing" : ""),
      style: {
        left: rect.x + "%",
        top: rect.y + "%",
        width: rect.w + "%",
        height: rect.h + "%",
        zIndex: z,
      },
    },
    editMode &&
      h(
        "div",
        {
          className: "im-drag-handle",
          onPointerDown: (e) => onMoveStart(e, panelId),
        },
        h("span", { className: "im-drag-handle-icon" }, "⠿"),
        label,
        h("span", { style: { marginLeft: "auto", opacity: 0.45 } }, "Drag")
      ),
    h(
      "div",
      {
        className:
          "im-panel-body" + (flushBody ? " im-panel-body--flush" : ""),
      },
      children
    ),
    editMode &&
      h("div", {
        className: "im-drag-resize",
        onPointerDown: (e) => onResizeStart(e, panelId),
      })
  );
}

function getPlayerItem() {
  const d = Spicetify.Player?.data;
  if (!d) return null;
  return d.item ?? d.track ?? null;
}

function getTrackMeta(item) {
  return item?.metadata ?? {};
}

function pickImage(item) {
  const m = getTrackMeta(item);
  return (
    m.image_xlarge_url ||
    m.image_large_url ||
    m.image_url ||
    (item?.images && item.images[0]?.url) ||
    ""
  );
}

function trackHasVideoMeta(meta) {
  if (!meta || typeof meta !== "object") return false;
  const id = meta.associated_video_id;
  if (id && String(id).trim() && String(id) !== "0") return true;
  const assoc = meta.video_association;
  if (assoc && assoc !== "NONE" && assoc !== "not_associated" && assoc !== "false")
    return true;
  return false;
}

async function fetchSpotifyLyrics(trackUri) {
  if (!trackUri || !trackUri.includes(":track:")) {
    return { lines: [], error: "No track" };
  }
  const id = trackUri.split(":")[2];
  const url = `https://spclient.wg.spotify.com/color-lyrics/v2/track/${id}?format=json&vocalRemoval=false&market=from_token`;
  try {
    const body = await Spicetify.CosmosAsync.get(url);
    const lyrics = body?.lyrics;
    if (!lyrics?.lines?.length) return { lines: [], error: "No lyrics" };
    const synced = lyrics.syncType === "LINE_SYNCED";
    const lines = lyrics.lines.map((line) => ({
      startTime: synced ? Number(line.startTimeMs) : undefined,
      text: line.words || "",
    }));
    return { lines, synced, error: null };
  } catch (e) {
    return { lines: [], error: String(e?.message ?? e) };
  }
}

function findBestVideoEl(alreadyDocked) {
  const videos = [...document.querySelectorAll("video")].filter((v) => {
    if (alreadyDocked && v === alreadyDocked) return true;
    return !v.closest(".im-fs");
  });
  if (!videos.length) return null;
  const scored = videos.map((v) => {
    const w = v.videoWidth || v.clientWidth;
    const h = v.videoHeight || v.clientHeight;
    const area = w * h;
    const active = !v.paused && v.readyState >= 2;
    return { v, area, active };
  });
  scored.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return b.area - a.area;
  });
  return scored[0]?.v ?? null;
}

function storeVideoRestore(video) {
  if (!video || video.__imRestore) return;
  video.__imRestore = { parent: video.parentNode, next: video.nextSibling };
}

function moveVideoTo(container, video) {
  if (!container || !video) return;
  storeVideoRestore(video);
  container.appendChild(video);
}

function restoreVideo(video) {
  if (!video?.__imRestore) return;
  const { parent, next } = video.__imRestore;
  if (!parent) return;
  try {
    if (next && next.parentNode === parent) parent.insertBefore(video, next);
    else parent.appendChild(video);
  } catch (_) {
    /* keep in place */
  }
}

function trySetPlaybackSpeed(rate) {
  const clamped = Math.min(2, Math.max(0.5, rate));
  try {
    const api = Spicetify.Platform?.PlayerAPI;
    if (api && typeof api.setPlaybackSpeed === "function") {
      api.setPlaybackSpeed(clamped);
      return { ok: true, method: "setPlaybackSpeed" };
    }
    if (api && typeof api.setSpeed === "function") {
      api.setSpeed(clamped);
      return { ok: true, method: "setSpeed" };
    }
  } catch (_) {}
  return { ok: false, method: null };
}

/** One revolution duration at 33⅓ RPM (~1.8s); spin scales with user's speed slider */
function vinylRotationSeconds(displaySpeed) {
  const base = 60 / 33.333;
  return base / Math.max(0.25, displaySpeed);
}

const TONEARM_VARIANTS = new Set([
  "classic",
  "minimal",
  "scurve",
  "retro",
]);

function TonearmSvg({ progress, variant }) {
  const angle = 18 + (1 - progress) * 22;
  const v = variant && TONEARM_VARIANTS.has(variant) ? variant : "classic";
  const gid = `im-arm-grad-${v}`;

  const classic = h(
    react.Fragment,
    null,
    h(
      "defs",
      null,
      h(
        "linearGradient",
        { id: gid, x1: "0", x2: "1" },
        h("stop", { offset: "0%", stopColor: "#8a8a8a" }),
        h("stop", { offset: "100%", stopColor: "#3a3a3a" })
      )
    ),
    h("path", {
      d: "M88 8 L46 78 L38 76 L62 14 Z",
      fill: `url(#${gid})`,
      stroke: "rgba(255,255,255,0.25)",
      strokeWidth: 0.8,
    }),
    h("circle", { cx: "88", cy: "10", r: "5", fill: "#ddd" }),
    h("line", {
      x1: "46",
      y1: "78",
      x2: "34",
      y2: "94",
      stroke: "#ccc",
      strokeWidth: "2.5",
      strokeLinecap: "round",
    })
  );

  const minimal = h(
    react.Fragment,
    null,
    h("line", {
      x1: "90",
      y1: "11",
      x2: "36",
      y2: "89",
      stroke: "#c8c8c8",
      strokeWidth: "2.2",
      strokeLinecap: "round",
    }),
    h("line", {
      x1: "36",
      y1: "89",
      x2: "28",
      y2: "96",
      stroke: "#a0a0a0",
      strokeWidth: "1.8",
      strokeLinecap: "round",
    }),
    h("circle", { cx: "90", cy: "11", r: "5", fill: "#e8e8e8" }),
    h("circle", { cx: "90", cy: "11", r: "2.2", fill: "#555" })
  );

  const scurve = h(
    react.Fragment,
    null,
    h(
      "defs",
      null,
      h(
        "linearGradient",
        { id: gid, x1: "0", y1: "0", x2: "1", y2: "1" },
        h("stop", { offset: "0%", stopColor: "#9a9a9a" }),
        h("stop", { offset: "100%", stopColor: "#2d2d2d" })
      )
    ),
    h("path", {
      d: "M88 10 C 72 12, 68 28, 64 48 S 52 72, 32 90 L 26 87 C 48 68, 56 52, 60 34 S 74 14, 88 10 Z",
      fill: `url(#${gid})`,
      stroke: "rgba(255,255,255,0.2)",
      strokeWidth: 0.6,
    }),
    h("circle", { cx: "88", cy: "10", r: "4.5", fill: "#ddd" })
  );

  const retro = h(
    react.Fragment,
    null,
    h(
      "defs",
      null,
      h(
        "linearGradient",
        { id: gid, x1: "0", y1: "0", x2: "1", y2: "1" },
        h("stop", { offset: "0%", stopColor: "#c9a227" }),
        h("stop", { offset: "55%", stopColor: "#7a5c12" }),
        h("stop", { offset: "100%", stopColor: "#3d2e0a" })
      )
    ),
    h("path", {
      d: "M86 6 L48 76 L40 74 L58 12 Z M44 78 L30 94 L38 96 L52 80 Z",
      fill: `url(#${gid})`,
      stroke: "rgba(60,40,10,0.35)",
      strokeWidth: 0.6,
    }),
    h("circle", { cx: "86", cy: "8", r: "6", fill: "#d4af37" }),
    h("circle", { cx: "86", cy: "8", r: "2.5", fill: "#5c4a1a" })
  );

  let body;
  if (v === "minimal") body = minimal;
  else if (v === "scurve") body = scurve;
  else if (v === "retro") body = retro;
  else body = classic;

  return h(
    "svg",
    {
      className: "im-tonearm im-tonearm--" + v,
      viewBox: "0 0 100 100",
      style: { transform: `rotate(${angle}deg)` },
      "aria-hidden": true,
    },
    body
  );
}

function imToggleClass(active) {
  return "im-btn im-toggle " + (active ? "im-toggle--on" : "im-toggle--off");
}

function SettingsPanel({
  videoMeta,
  showTime,
  setShowTime,
  showControls,
  setShowControls,
  showLyrics,
  setShowLyrics,
  videoMode,
  setVideoMode,
  vinylMode,
  setVinylMode,
  vinylArm,
  setVinylArm,
  tonearmStyle,
  setTonearmStyle,
  speed,
  setSpeed,
  speedAudioWorks,
  layoutEditMode,
  setLayoutEditMode,
  layoutGridLock,
  setLayoutGridLock,
  onResetLayout,
}) {
  return h(
    "div",
    { className: "im-panel", role: "dialog", "aria-label": "Immersive settings" },
    h("h3", null, "Fullscreen settings"),
    h(
      "div",
      { className: "im-row" },
      h("span", null, "Custom layout editor"),
      h(
        "button",
        {
          className: imToggleClass(layoutEditMode),
          style: { padding: "6px 14px", fontSize: "0.8rem" },
          onClick: () => setLayoutEditMode((v) => !v),
        },
        layoutEditMode ? "On" : "Off"
      )
    ),
    h(
      "div",
      { className: "im-row" },
      h("span", null, "Grid lock (snap)"),
      h(
        "button",
        {
          className: imToggleClass(layoutGridLock),
          style: { padding: "6px 14px", fontSize: "0.8rem" },
          onClick: () => {
            const v = !layoutGridLock;
            setLayoutGridLock(v);
            writeBool("layoutGridLock", v);
          },
        },
        layoutGridLock ? "On" : "Off"
      )
    ),
    h(
      "p",
      { className: "im-hint" },
      layoutGridLock
        ? "Panels snap to a 5% grid while moving or resizing. Turn off for free placement."
        : "Turn on “Grid lock” to snap panels to a 5% grid. Drag Album / video, Lyrics, and Transport by their handles; corner grip resizes. Layout saves when you release."
    ),
    h(
      "div",
      { className: "im-row" },
      h("span", null, "Reset layout"),
      h(
        "button",
        {
          className: "im-btn",
          style: { padding: "6px 14px", fontSize: "0.8rem" },
          onClick: onResetLayout,
        },
        "Reset"
      )
    ),
    h(
      "div",
      { className: "im-row" },
      h("span", null, "Show time & scrubber"),
      h(
        "button",
        {
          className: imToggleClass(showTime),
          style: { padding: "6px 14px", fontSize: "0.8rem" },
          onClick: () => {
            const v = !showTime;
            setShowTime(v);
            writeBool("showTime", v);
          },
        },
        showTime ? "On" : "Off"
      )
    ),
    h(
      "div",
      { className: "im-row" },
      h("span", null, "Playback buttons"),
      h(
        "button",
        {
          className: imToggleClass(showControls),
          style: { padding: "6px 14px", fontSize: "0.8rem" },
          onClick: () => {
            const v = !showControls;
            setShowControls(v);
            writeBool("showControls", v);
          },
        },
        showControls ? "On" : "Off"
      )
    ),
    h(
      "div",
      { className: "im-row" },
      h("span", null, "Lyrics column"),
      h(
        "button",
        {
          className: imToggleClass(showLyrics),
          style: { padding: "6px 14px", fontSize: "0.8rem" },
          onClick: () => {
            const v = !showLyrics;
            setShowLyrics(v);
            writeBool("showLyrics", v);
          },
        },
        showLyrics ? "On" : "Off"
      )
    ),
    h(
      "div",
      { className: "im-row" },
      h("span", null, "Music video layout"),
      h(
        "select",
        {
          className: "im-select",
          value: videoMode,
          disabled: !videoMeta,
          onChange: (e) => {
            const v = e.target.value;
            setVideoMode(v);
            writeStr("videoMode", v);
          },
        },
        h("option", { value: "cover-only" }, "Album cover only"),
        h("option", { value: "split" }, "Video left · lyrics right"),
        h("option", { value: "fullscreen" }, "Video fullscreen + lyrics")
      )
    ),
    !videoMeta &&
      h("p", { className: "im-hint" }, "Current track has no linked music video in metadata."),
    h(
      "div",
      { className: "im-row" },
      h("span", null, "Vinyl look (round cover)"),
      h(
        "button",
        {
          className: imToggleClass(vinylMode),
          style: { padding: "6px 14px", fontSize: "0.8rem" },
          onClick: () => {
            const v = !vinylMode;
            setVinylMode(v);
            writeBool("vinylMode", v);
          },
        },
        vinylMode ? "On" : "Off"
      )
    ),
    h(
      "div",
      { className: "im-row" },
      h("span", null, "Tonearm (vinyl mode)"),
      h(
        "button",
        {
          className: imToggleClass(vinylArm) + (!vinylMode ? " im-toggle--disabled" : ""),
          style: { padding: "6px 14px", fontSize: "0.8rem" },
          disabled: !vinylMode,
          onClick: () => {
            const v = !vinylArm;
            setVinylArm(v);
            writeBool("vinylArm", v);
          },
        },
        vinylArm ? "On" : "Off"
      )
    ),
    h(
      "div",
      { className: "im-row" },
      h("span", null, "Tonearm style"),
      h(
        "select",
        {
          className: "im-select",
          value: tonearmStyle,
          disabled: !vinylMode || !vinylArm,
          onChange: (e) => {
            const v = e.target.value;
            setTonearmStyle(v);
            writeStr("tonearmStyle", v);
          },
        },
        h("option", { value: "classic" }, "Classic"),
        h("option", { value: "minimal" }, "Minimal straight"),
        h("option", { value: "scurve" }, "S-curve"),
        h("option", { value: "retro" }, "Retro brass")
      )
    ),
    h("h3", { style: { marginTop: 20 } }, "Speed"),
    h(
      "p",
      { className: "im-hint" },
      speedAudioWorks
        ? "Adjusts playback in the client when supported; vinyl spin follows the same multiplier."
        : "Your client did not accept programmatic speed changes — the slider still drives the spinning record. Playback speed may be available in Spotify’s own controls for podcasts."
    ),
    h("input", {
      type: "range",
      className: "im-speed",
      min: "0.5",
      max: "2",
      step: "0.05",
      value: speed,
      onChange: (e) => {
        const v = Number(e.target.value);
        setSpeed(v);
        localStorage.setItem(LS + "speed", String(v));
      },
    }),
    h(
      "div",
      { className: "im-time-row", style: { marginTop: 6 } },
      h("span", null, `${speed.toFixed(2)}×`)
    )
  );
}

function FullscreenView({ onClose }) {
  const [showTime, setShowTime] = useState(() => readBool("showTime", true));
  const [showControls, setShowControls] = useState(() => readBool("showControls", true));
  const [showLyrics, setShowLyrics] = useState(() => readBool("showLyrics", true));
  const [videoMode, setVideoMode] = useState(() =>
    readStr("videoMode", "split")
  );
  const [vinylMode, setVinylMode] = useState(() => readBool("vinylMode", false));
  const [vinylArm, setVinylArm] = useState(() => readBool("vinylArm", true));
  const [tonearmStyle, setTonearmStyle] = useState(() => {
    const s = readStr("tonearmStyle", "classic");
    return TONEARM_VARIANTS.has(s) ? s : "classic";
  });
  const [speed, setSpeed] = useState(() => readFloat("speed", 1));
  const [speedAudioWorks, setSpeedAudioWorks] = useState(false);

  const [panelOpen, setPanelOpen] = useState(false);
  const [layoutEditMode, setLayoutEditMode] = useState(false);
  const [layoutGridLock, setLayoutGridLock] = useState(() =>
    readBool("layoutGridLock", false)
  );
  const [layout, setLayout] = useState(
    () => readLayout() ?? { ...DEFAULT_LAYOUT_SPLIT }
  );
  const [zMap, setZMap] = useState({ media: 10, lyrics: 11, transport: 12 });
  const layoutCanvasRef = useRef(null);
  const layoutDragRef = useRef(null);

  const [meta, setMeta] = useState(() => {
    const item = getPlayerItem();
    return { title: "", artist: "", image: "", uri: "", videoMeta: false };
  });
  const [lyricsState, setLyricsState] = useState({
    lines: [],
    synced: false,
  });
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(() => Spicetify.Player?.isPlaying());
  const [activeLine, setActiveLine] = useState(0);

  const rootRef = useRef(null);
  const videoHostRef = useRef(null);
  const lyricsRef = useRef(null);
  const lineRefs = useRef([]);
  const attachedVideoRef = useRef(null);

  const refreshTrack = useCallback(() => {
    const item = getPlayerItem();
    const m = getTrackMeta(item);
    const title = m.title || item?.name || "";
    const artist = m.artist_name || item?.artists?.[0]?.name || "";
    const image = pickImage(item);
    const uri = item?.uri || "";
    setMeta({
      title,
      artist,
      image,
      uri,
      videoMeta: trackHasVideoMeta(m),
    });
  }, []);

  useEffect(() => {
    refreshTrack();
    const onSong = () => {
      if (attachedVideoRef.current) {
        restoreVideo(attachedVideoRef.current);
        attachedVideoRef.current = null;
      }
      refreshTrack();
    };
    Spicetify.Player.addEventListener("songchange", onSong);
    return () => Spicetify.Player.removeEventListener("songchange", onSong);
  }, [refreshTrack]);

  useEffect(() => {
    if (!meta.uri) {
      setLyricsState({ lines: [], synced: false });
      return;
    }
    let cancel = false;
    (async () => {
      const res = await fetchSpotifyLyrics(meta.uri);
      if (!cancel) setLyricsState({ lines: res.lines, synced: !!res.synced });
    })();
    return () => {
      cancel = true;
    };
  }, [meta.uri]);

  useEffect(() => {
    const r = trySetPlaybackSpeed(speed);
    setSpeedAudioWorks(r.ok);
  }, [speed]);

  useEffect(() => {
    const v = attachedVideoRef.current;
    if (!v) return;
    try {
      v.playbackRate = speed;
    } catch (_) {}
  }, [speed]);

  useEffect(() => {
    const t = () => {
      setProgress(Spicetify.Player.getProgress());
      setDuration(Spicetify.Player.getDuration());
      setPlaying(Spicetify.Player.isPlaying());
    };
    t();
    Spicetify.Player.addEventListener("onprogress", t);
    Spicetify.Player.addEventListener("onplaypause", t);
    return () => {
      Spicetify.Player.removeEventListener("onprogress", t);
      Spicetify.Player.removeEventListener("onplaypause", t);
    };
  }, []);

  useEffect(() => {
    const lines = lyricsState.lines;
    if (!lines.length || !lyricsState.synced) {
      setActiveLine(-1);
      return;
    }
    let idx = 0;
    for (let i = 0; i < lines.length; i++) {
      const st = lines[i].startTime ?? 0;
      const next = lines[i + 1]?.startTime ?? duration + 999;
      if (progress >= st && progress < next) {
        idx = i;
        break;
      }
      if (progress >= st) idx = i;
    }
    setActiveLine(idx);
  }, [progress, duration, lyricsState.lines, lyricsState.synced]);

  useEffect(() => {
    const el = lineRefs.current[activeLine];
    if (el && lyricsRef.current)
      el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeLine]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const goFs =
      el.requestFullscreen ||
      el.webkitRequestFullscreen ||
      el.mozRequestFullScreen ||
      el.msRequestFullscreen;
    if (goFs) goFs.call(el).catch(() => {});
    const onFs = () => {
      if (!document.fullscreenElement) onClose();
    };
    document.addEventListener("fullscreenchange", onFs);
    return () => {
      document.removeEventListener("fullscreenchange", onFs);
      if (attachedVideoRef.current) {
        restoreVideo(attachedVideoRef.current);
        attachedVideoRef.current = null;
      }
      if (document.fullscreenElement === el) {
        const x =
          document.exitFullscreen ||
          document.webkitExitFullscreen ||
          document.mozCancelFullScreen ||
          document.msExitFullscreen;
        if (x) x.call(document).catch(() => {});
      }
    };
  }, [onClose]);

  const effectiveVideoLayout = meta.videoMeta ? videoMode : "cover-only";
  const showVideoSplit =
    effectiveVideoLayout === "split" && meta.videoMeta;
  const showVideoFull =
    effectiveVideoLayout === "fullscreen" && meta.videoMeta;

  const videoFullLayout = showVideoFull && meta.videoMeta;
  const videoSplitLayout = showVideoSplit && meta.videoMeta;

  const resetLayout = useCallback(() => {
    const def = videoFullLayout ? DEFAULT_LAYOUT_VIDEOFULL : DEFAULT_LAYOUT_SPLIT;
    const next = {
      media: { ...def.media },
      lyrics: { ...def.lyrics },
      transport: { ...def.transport },
    };
    setLayout(next);
    persistLayoutObj(next);
    setZMap({ media: 10, lyrics: 11, transport: 12 });
  }, [videoFullLayout]);

  const bringPanelToFront = useCallback((id) => {
    setZMap((zm) => {
      const max = Math.max(zm.media, zm.lyrics, zm.transport);
      return { ...zm, [id]: max + 1 };
    });
  }, []);

  const attachLayoutDrag = useCallback(
    (e, id, mode) => {
      if (!layoutEditMode) return;
      e.preventDefault();
      e.stopPropagation();
      bringPanelToFront(id);
      const canvas = layoutCanvasRef.current;
      if (!canvas) return;
      const cr = canvas.getBoundingClientRect();
      const rect0 = { ...layout[id] };
      layoutDragRef.current = {
        id,
        mode,
        sx: e.clientX,
        sy: e.clientY,
        cw: Math.max(1, cr.width),
        ch: Math.max(1, cr.height),
        rect0,
      };
      const onMove = (ev) => {
        const d = layoutDragRef.current;
        if (!d) return;
        const dxPct = ((ev.clientX - d.sx) / d.cw) * 100;
        const dyPct = ((ev.clientY - d.sy) / d.ch) * 100;
        setLayout((prev) => {
          const base = d.rect0;
          const raw =
            d.mode === "move"
              ? clampRect({
                  x: base.x + dxPct,
                  y: base.y + dyPct,
                  w: base.w,
                  h: base.h,
                })
              : clampRect({
                  x: base.x,
                  y: base.y,
                  w: base.w + dxPct,
                  h: base.h + dyPct,
                });
          const nextR = snapRectToGrid(raw, layoutGridLock);
          return { ...prev, [d.id]: nextR };
        });
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        const lastId = layoutDragRef.current?.id;
        layoutDragRef.current = null;
        setLayout((prev) => {
          if (!lastId) {
            persistLayoutObj(prev);
            return prev;
          }
          const next = {
            ...prev,
            [lastId]: snapRectToGrid(prev[lastId], layoutGridLock),
          };
          persistLayoutObj(next);
          return next;
        });
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [layoutEditMode, layout, layoutGridLock, bringPanelToFront]
  );

  useEffect(() => {
    if (!showVideoSplit && !showVideoFull) {
      if (attachedVideoRef.current) {
        restoreVideo(attachedVideoRef.current);
        attachedVideoRef.current = null;
      }
      return;
    }
    let timer = window.setInterval(() => {
      const host = videoHostRef.current;
      if (!host) return;
      const v = findBestVideoEl(attachedVideoRef.current);
      if (v && v !== attachedVideoRef.current) {
        if (attachedVideoRef.current) restoreVideo(attachedVideoRef.current);
        moveVideoTo(host, v);
        attachedVideoRef.current = v;
      }
      const cur = attachedVideoRef.current;
      if (cur) {
        try {
          cur.playbackRate = speed;
        } catch (_) {}
      }
    }, 400);
    return () => {
      clearInterval(timer);
    };
  }, [showVideoSplit, showVideoFull, meta.uri, speed]);

  const progressPct = duration > 0 ? progress / duration : 0;
  const rotSec = vinylRotationSeconds(speed);

  const rootClass =
    "im-fs" +
    (showVideoFull && meta.videoMeta ? " im-fs-video-full" : "");

  const videoFallback = h("img", {
    className: "im-cover",
    src: meta.image || "",
    alt: "",
    style: {
      position: "absolute",
      inset: 0,
      width: "100%",
      height: "100%",
      objectFit: "cover",
      zIndex: 0,
    },
  });

  const coverOrVinyl = h(
    "div",
    {
      className:
        "im-cover-wrap im-cover-wrap--in-panel" + (vinylMode ? " im-vinyl" : ""),
    },
    vinylMode &&
      h(
        "div",
        {
          className: "im-vinyl-spin" + (playing ? "" : " is-paused"),
          style: {
            animationDuration: `${rotSec}s`,
            width: "100%",
            height: "100%",
            position: "relative",
          },
        },
        h("img", {
          className: "im-cover",
          src: meta.image || "",
          alt: "",
        }),
        h("div", { className: "im-vinyl-groove" }),
        h(
          "div",
          { className: "im-vinyl-label" },
          meta.image && h("img", { src: meta.image, alt: "", draggable: false })
        )
      ),
    !vinylMode &&
      h("img", {
        className: "im-cover",
        src: meta.image || "",
        alt: "",
      }),
    vinylMode &&
      vinylArm &&
      h(TonearmSvg, { progress: progressPct, variant: tonearmStyle })
  );

  const mediaPanelContent = h(
    "div",
    { className: "im-panel-media-fill" },
    videoFullLayout
      ? h(
          "div",
          {
            ref: videoHostRef,
            className: "im-video-host im-video-host--full",
            style: { position: "relative" },
          },
          videoFallback
        )
      : videoSplitLayout
        ? h(
            "div",
            {
              ref: videoHostRef,
              className: "im-video-host",
              style: {
                position: "relative",
                width: "100%",
                height: "100%",
                maxHeight: "100%",
              },
            },
            videoFallback
          )
        : coverOrVinyl
  );

  const lyricsPanelContent = showLyrics
    ? h(
        "div",
        { className: "im-lyrics-block" },
        h(
          "div",
          { className: "im-lyrics", ref: lyricsRef },
          lyricsState.lines.length === 0 &&
            h(
              "p",
              { style: { opacity: 0.6 } },
              "No lyrics from Spotify for this track."
            ),
          lyricsState.lines.length > 0 &&
            !lyricsState.synced &&
            h(
              "p",
              {
                style: {
                  opacity: 0.55,
                  fontSize: "0.95rem",
                  marginBottom: 12,
                },
              },
              "These lines are not time-synced — highlighting follows playback when Spotify provides timestamps."
            ),
          lyricsState.lines.map((line, i) => {
            let cls = "im-lyric-line";
            if (lyricsState.synced && activeLine >= 0) {
              if (i === activeLine) cls += " is-active";
              else if (i < activeLine) cls += " is-passed";
            }
            return h(
              "p",
              {
                key: i,
                className: cls,
                ref: (el) => {
                  lineRefs.current[i] = el;
                },
              },
              line.text
            );
          })
        )
      )
    : h(
        "p",
        {
          style: {
            opacity: 0.55,
            padding: 12,
            margin: 0,
            lineHeight: 1.45,
          },
        },
        "Lyrics are turned off. Enable “Lyrics column” in settings to show them in this panel."
      );

  const transportPanelContent = h(
    react.Fragment,
    null,
    showTime &&
      h(
        "div",
        { className: "im-time-row", style: { marginTop: 0 } },
        h("span", null, Spicetify.Player.formatTime(progress)),
        h("input", {
          type: "range",
          className: "im-scrub",
          min: 0,
          max: 1,
          step: 0.001,
          value: progressPct,
          onChange: (e) => Spicetify.Player.seek(Number(e.target.value)),
        }),
        h("span", null, Spicetify.Player.formatTime(duration))
      ),
    showControls &&
      h(
        "div",
        { className: "im-controls" },
        h(
          "button",
          {
            type: "button",
            title: "Previous",
            onClick: () => Spicetify.Player.back(),
          },
          "⏮"
        ),
        h(
          "button",
          {
            type: "button",
            className: "im-play",
            title: playing ? "Pause" : "Play",
            onClick: () => Spicetify.Player.togglePlay(),
          },
          playing ? "⏸" : "▶"
        ),
        h(
          "button",
          {
            type: "button",
            title: "Next",
            onClick: () => Spicetify.Player.next(),
          },
          "⏭"
        )
      ),
    !showTime &&
      !showControls &&
      layoutEditMode &&
      h(
        "p",
        { style: { opacity: 0.55, padding: 8, margin: 0, lineHeight: 1.4 } },
        "Time and playback controls are off. Turn them on in settings to use this panel."
      )
  );

  return h(
    "div",
    { className: rootClass, ref: rootRef },
    h("div", {
      className: "im-fs-bg",
      style: { backgroundImage: meta.image ? `url("${meta.image}")` : "none" },
    }),
    h("div", { className: "im-fs-bg-fade" }),
    h(
      "header",
      { className: "im-fs-top" },
      h(
        "div",
        { className: "im-track-meta" },
        h("p", { className: "im-track-title" }, meta.title || "Not playing"),
        h("p", { className: "im-track-artist" }, meta.artist)
      ),
      h(
        "div",
        { className: "im-toolbar" },
        h(
          "button",
          {
            className: "im-icon-btn",
            title: "Settings",
            onClick: () => setPanelOpen((p) => !p),
          },
          "⚙"
        ),
        h(
          "button",
          {
            className: "im-icon-btn",
            title: "Exit fullscreen",
            onClick: onClose,
          },
          "✕"
        )
      )
    ),
    panelOpen &&
      h(SettingsPanel, {
        videoMeta: meta.videoMeta,
        showTime,
        setShowTime,
        showControls,
        setShowControls,
        showLyrics,
        setShowLyrics,
        videoMode,
        setVideoMode,
        vinylMode,
        setVinylMode,
        vinylArm,
        setVinylArm,
        tonearmStyle,
        setTonearmStyle,
        speed,
        setSpeed,
        speedAudioWorks,
        layoutEditMode,
        setLayoutEditMode,
        layoutGridLock,
        setLayoutGridLock,
        onResetLayout: resetLayout,
      }),
    h(
      "div",
      {
        className:
          "im-layout-canvas" +
          (layoutEditMode ? " is-edit-mode" : "") +
          (layoutGridLock && layoutEditMode ? " im-layout-canvas--snap" : ""),
        ref: layoutCanvasRef,
      },
      h(DragLayoutPanel, {
        panelId: "media",
        label: "Album / video",
        rect: layout.media,
        z: zMap.media,
        editMode: layoutEditMode,
        flushBody: true,
        onMoveStart: (e, id) => attachLayoutDrag(e, id, "move"),
        onResizeStart: (e, id) => attachLayoutDrag(e, id, "resize"),
      }, mediaPanelContent),
      (showLyrics || layoutEditMode) &&
        h(DragLayoutPanel, {
          panelId: "lyrics",
          label: "Lyrics",
          rect: layout.lyrics,
          z: zMap.lyrics,
          editMode: layoutEditMode,
          onMoveStart: (e, id) => attachLayoutDrag(e, id, "move"),
          onResizeStart: (e, id) => attachLayoutDrag(e, id, "resize"),
        }, lyricsPanelContent),
      (showTime || showControls || layoutEditMode) &&
        h(DragLayoutPanel, {
          panelId: "transport",
          label: "Time & playback",
          rect: layout.transport,
          z: zMap.transport,
          editMode: layoutEditMode,
          onMoveStart: (e, id) => attachLayoutDrag(e, id, "move"),
          onResizeStart: (e, id) => attachLayoutDrag(e, id, "resize"),
        }, transportPanelContent)
    )
  );
}

function ImmersiveHome() {
  const [fsOpen, setFsOpen] = useState(true);

  const handleCloseFullscreen = useCallback(() => {
    setFsOpen(false);
    navigateToSpotifyHome();
  }, []);

  return h(
    react.Fragment,
    null,
    fsOpen && h(FullscreenView, { onClose: handleCloseFullscreen }),
    !fsOpen &&
      h(
        "section",
        { className: "im-root contentSpacing" },
        h("div", { className: "im-card" },
          h("h1", { className: "im-title" }, "Immersive Player"),
          h(
            "p",
            { className: "im-desc" },
            "You’re still on this app page. If Home didn’t open, use the Home icon in the sidebar. You can open the immersive fullscreen again below."
          ),
          h(
            "button",
            {
              type: "button",
              className: "im-btn",
              onClick: () => setFsOpen(true),
            },
            "Open immersive view"
          ),
          h(
            "p",
            {
              className: "im-desc",
              style: { marginTop: 16, fontSize: "0.85rem", opacity: 0.85 },
            },
            "Install: copy this folder to ",
            h("code", null, "%appdata%\\spicetify\\CustomApps"),
            ", add ",
            h("code", null, "immersive-player"),
            " to ",
            h("code", null, "custom_apps"),
            " in ",
            h("code", null, "config-xpui.ini"),
            ", run ",
            h("code", null, "spicetify apply"),
            ". ",
            h(
              "a",
              {
                href: "https://spicetify.app/docs/development/custom-apps",
                target: "_blank",
                rel: "noopener noreferrer",
              },
              "Docs"
            )
          )
        )
      )
  );
}

function render() {
  return h(ImmersiveHome, null);
}
