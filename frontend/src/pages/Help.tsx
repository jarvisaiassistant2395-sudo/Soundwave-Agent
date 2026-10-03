import { Clapperboard, Mic, MessageCircleQuestion, Bot, Cpu, ShieldCheck, AudioLines, Smartphone, Brain, Sunrise, Youtube } from "lucide-react";
import { Link } from "react-router-dom";

/** Soundwave AI — Complete Documentation & Architecture Guide */
export function Help() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-white">Help & Documentation</h1>
        <p className="mt-1 text-sm text-gray-400">
          Everything you need to master Soundwave AI, the Autonomous Viral Shorts Agent, and commercial distribution.
        </p>
        <p className="mt-3 rounded-lg border border-cyan-500/20 bg-cyan-500/5 px-4 py-3 text-sm text-cyan-100">
          Easiest: just ask the agent. “How do I link my YouTube channel?”, “What does Morning Setup do?”, “Why can't my phone connect?” — it explains every feature step by step, with the real button names.
        </p>
      </div>

      <div className="space-y-5">
        {/* Soundwave Agent */}
        <Section icon={<Bot className="h-4 w-4" />} title="Soundwave Agent — Autonomous Viral Shorts">
          <p className="text-sm text-gray-300">
            The <span className="text-cyan-300 font-semibold">Soundwave Agent</span> in the Command Center is the one that makes videos — high-retention, faceless vertical shorts (YouTube Shorts, TikTok, Reels). Press Generate or just tell it "make a short about…" in the chat.
          </p>
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-gray-300">
            <li><strong className="text-white">Research-Backed Hooks:</strong> Built-in 2026 viral hooks (Did you know, Only 1% know, 3 mistakes, You're doing X wrong, Curiosity loop, Contrarian take).</li>
            <li><strong className="text-white">7 Proven Niches:</strong> Psychology & Dark Mind Tricks, Mind-Bending Facts, Untold History, Money & Wealth, AI & Future Tech, Deep Motivation, and Cosmic Horror.</li>
            <li><strong className="text-white">1-Click Full Pipeline:</strong> Script written by Gemini for your topic (or a built-in viral script without a key) → narration in your Soundwave voice → word-by-word captions → Orbital NCG gameplay background (imported via the YouTube link importer) → FFmpeg 9:16 render → instant download.</li>
            <li><strong className="text-white">Batch Mode:</strong> Single-click generation of all 7 niches simultaneously with automated export tracking.</li>
          </ul>
          <Link to="/agent" className="mt-4 inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-violet-600 px-4 py-2 text-sm font-semibold text-white hover:from-cyan-400 hover:to-violet-500 shadow-md shadow-violet-500/20">
            <Bot className="h-4 w-4" /> Open the Command Center
          </Link>
        </Section>

        {/* The agent's brain */}
        <Section icon={<Brain className="h-4 w-4" />} title="The Agent's Brain (Google Gemini)">
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-gray-300">
            <li><strong className="text-white">Add your own Gemini API key once:</strong> <Link to="/settings/brain" className="text-cyan-300 hover:text-cyan-200">Settings → Brain</Link>. It's free from <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="text-cyan-300 hover:text-cyan-200">Google AI Studio</a> — sign in, click "Create API key", paste it, press "Save &amp; test".</li>
            <li><strong className="text-white">Then just talk to it:</strong> ask questions, brainstorm hooks and titles, or say "make a short about black holes for kids" — Gemini writes the short's script for that topic. "Show me my last video", "open YouTube", "open Spotify" and "how busy is my PC?" work too.</li>
            <li><strong className="text-white">Honest about its limits:</strong> it only says it did something when it really did. It can't change volume, read your screen or files, or set timers yet — it tells you instead of pretending.</li>
            <li><strong className="text-white">Free limits:</strong> Google's free tier allows a limited number of requests per day for each model. If they run out, the agent switches to a lighter Gemini model; you can also pick another model in Settings → Brain. Web search (live news, weather, prices) needs a key with billing turned on.</li>
            <li><strong className="text-white">Privacy:</strong> your messages and the recent conversation go to Google's Gemini API with your key (on the free tier Google may use them to improve its products). The key stays on this PC. Without a key the agent still makes shorts, with built-in scripts.</li>
          </ul>
        </Section>

        {/* Memory + Morning Setup */}
        <Section icon={<Sunrise className="h-4 w-4" />} title="Memory and Morning Setup">
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-gray-300">
            <li><strong className="text-white">It remembers:</strong> notes it saves (“remember that my channel is about space”), a summary of earlier conversations (Gemini updates it as the chat grows and when you press Clear) and the shorts you made. See, add or delete notes in the Command Center → gear → <em>Memory</em>.</li>
            <li><strong className="text-white">Your daily briefing, on anything:</strong> add topics in <Link to="/settings/morning" className="text-cyan-300 hover:text-cyan-200">Settings → Morning Setup</Link> (or tell the agent) — “the latest news about open-source, free AI tools”, “new trending GitHub repositories”… Every morning at your time Gemini researches them (Google Search, free with a free key) and the briefing starts talking when you open the app — on the phone even with the PC off.</li>
            <li><strong className="text-white">Morning Setup now:</strong> press <em>🌅 Morning Setup</em> (Command Center or phone) or say “good morning, run my morning setup”. It also opens your morning websites and apps on this PC (YouTube Studio by default). The briefing has the weather, your shorts, your YouTube numbers, what you were working on, your topics and three new short ideas.</li>
            <li><strong className="text-white">Customize it</strong> in Settings → Morning Setup: the time and topics, the weather city, what to open, whether to open it when you start from the phone, and the ideas.</li>
          </ul>
        </Section>

        {/* YouTube */}
        <Section icon={<Youtube className="h-4 w-4" />} title="Link Your YouTube Channel">
          <p className="text-sm text-gray-300">
            Command Center → gear → <em>YouTube &amp; Shorts</em> → <strong className="text-white">Connect YouTube</strong> → sign in with Google and allow it. That's the
            whole thing: <strong className="text-white">one press, nothing to set up in Google Cloud</strong>. The app carries its own Google client and asks only for
            permission to upload videos and read your channel's name. Remove the access any time at myaccount.google.com/permissions.
          </p>
          <p className="mt-3 text-xs text-gray-400">
            Developer or self-hosted build without Soundwave's Google client? The panel says so and shows the short path instead: your own free OAuth client
            (type <em>Desktop app</em>) in Google Cloud — three clicks, the app links straight to the pages. YouTube keeps uploads from brand-new projects private
            until the project passes YouTube's API audit. Ask the agent for the details, or press <em>Ask Soundwave to walk me through it</em> in the same tab.
          </p>
        </Section>

        {/* How the agent renders */}
        <Section icon={<Clapperboard className="h-4 w-4" />} title="How the Agent Renders a Short">
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-gray-300">
            <li><strong className="text-white">TikTok Subtitle Styling:</strong> Auto-synced word cues rendered in bold Montserrat 800 with high-contrast violet backgrounds (#8B5CF6) and dynamic center scaling.</li>
            <li><strong className="text-white">Fresh Orbital NCG Backgrounds:</strong> For every short the agent picks a video from youtube.com/@OrbitalNCG it has never used before, pastes its link into the YouTube link importer, and imports just the gameplay the short needs.</li>
            <li><strong className="text-white">Server-Side FFmpeg Engine:</strong> Professional H.264 rendering in 720p or 1080p 60fps vertical format (9:16), fit-to-voice audio duration, and seamless looping.</li>
          </ul>
        </Section>

        {/* Talking to the agent */}
        <Section icon={<AudioLines className="h-4 w-4" />} title="Talk to Soundwave (Voice Input)">
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-gray-300">
            <li><strong className="text-white">Tap the mic and talk:</strong> in the Command Center, tap the microphone (or the orb) and say what you'd type — "make a short about black holes". It sends by itself when you pause; tap again to send sooner. <strong className="text-white">Hold</strong> the mic instead for push-to-talk.</li>
            <li><strong className="text-white">From any app (desktop):</strong> press <kbd className="rounded bg-gray-800 px-1.5 py-0.5 text-xs">Ctrl+Shift+Space</kbd> — a small voice bar appears above the taskbar, listens, and answers out loud. Your words and the reply also land in the Command Center's conversation.</li>
            <li><strong className="text-white">Private by design:</strong> speech is recognized on your PC by whisper.cpp with a bundled English model — no account, no API key, and your voice is never uploaded. (Replies are still spoken with Microsoft's online Soundwave voices.)</li>
            <li><strong className="text-white">Tray & notifications (desktop):</strong> closing the window keeps Soundwave in the system tray, so the shortcut keeps working and shorts keep rendering; a Windows notification tells you when a short is ready. Quit from the tray icon.</li>
            <li><strong className="text-white">Options:</strong> <Link to="/settings/voice" className="text-cyan-300 hover:text-cyan-200">Settings → Voice &amp; Desktop</Link> — test the microphone, change the shortcut, start with Windows, sound cues, notifications.</li>
            <li><strong className="text-white">Microphone blocked?</strong> On Windows: Settings → Privacy &amp; security → Microphone → turn on "Microphone access" and "Let desktop apps access your microphone".</li>
          </ul>
        </Section>

        {/* Phone companion */}
        <Section icon={<Smartphone className="h-4 w-4" />} title="Use It From Your Phone">
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-gray-300">
            <li><strong className="text-white">The Soundwave phone app (Android)</strong> is a remote for the agent on this PC: type or talk, start shorts, watch them when they're done. It's the same conversation as the Command Center — messages from the phone are marked <em>YOU (PHONE)</em>.</li>
            <li><strong className="text-white">Pair once:</strong> <Link to="/settings/phone" className="text-cyan-300 hover:text-cyan-200">Settings → Phone</Link> → turn on "Let my phone connect", then tap <em>Scan QR code</em> in the app. No camera? Choose <em>Enter code</em> and type the address and code shown under the QR code.</li>
            <li><strong className="text-white">Same brain:</strong> the phone is answered by the agent on this PC, with your Gemini key from <Link to="/settings/brain" className="text-cyan-300 hover:text-cyan-200">Settings → Brain</Link> — nothing to set up on the phone. Web pages and apps it opens appear on this PC.</li>
            <li><strong className="text-white">The full agent while Soundwave AI runs here</strong> (the tray counts) and the phone is on the same Wi-Fi. If Windows asks whether Soundwave AI may use your network, allow it for private networks.</li>
            <li><strong className="text-white">PC off? It keeps chatting:</strong> with “Chat from the phone when this PC is off” on (<Link to="/settings/phone" className="text-cyan-300 hover:text-cyan-200">Settings → Phone</Link>), the phone talks to Gemini directly, with your conversation and the agent's memory — and everything goes back to this PC when it's reachable. Shorts, videos and PC actions wait for the PC.</li>
            <li><strong className="text-white">Private:</strong> the phone talks straight to this PC, end-to-end encrypted with a key set up from the QR code — nothing goes through the internet. Remove a phone any time in Settings → Phone.</li>
          </ul>
        </Section>

        {/* The agent's voice */}
        <Section icon={<Mic className="h-4 w-4" />} title="The Agent's Voice">
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-gray-300">
            <li><strong className="text-white">Soundwave voices only:</strong> the agent speaks its replies and narrates every short in the voice picked in the Command Center (or in the Voice Library / Settings) — Guy, Christopher, Ryan, Jenny, Ana or Sonia, Microsoft's neural voices.</li>
            <li><strong className="text-white">Starts talking right away:</strong> replies are streamed while they're synthesized, so there's no wait for the whole answer.</li>
            <li><strong className="text-white">Needs the internet:</strong> the voices come from Microsoft's online speech service. If it can't be reached, the app says why instead of falling back to a robotic computer voice — and a short is never rendered with a stand-in voice.</li>
          </ul>
        </Section>

        {/* Standalone Desktop Agent */}
        <Section icon={<Cpu className="h-4 w-4" />} title="Standalone Desktop Runner (Python)">
          <div className="text-sm text-gray-300 space-y-2">
            <p>The <code className="rounded bg-gray-800 px-1.5 py-0.5 text-xs">soundwave-agent/</code> package allows Soundwave AI to run as an independent, local desktop assistant on Windows, macOS, or Linux without any browser overhead.</p>
            <ul className="list-disc space-y-1 pl-5 text-xs text-gray-400">
              <li><strong className="text-white">Soundwave Reactive HUD:</strong> Clean, futuristic audio visualizer that pulses to speech and rendering tasks — no weird 3D face avatar.</li>
              <li><strong className="text-white">CLI & GUI:</strong> Run <code className="text-cyan-300">python soundwave-agent/main.py --batch</code> for one-line viral content generation.</li>
              <li><strong className="text-white">Direct REST API:</strong> Communicates directly with the Soundwave backend to automate rendering and downloads.</li>
            </ul>
          </div>
        </Section>

        {/* Commercial Licensing */}
        <Section icon={<ShieldCheck className="h-4 w-4" />} title="Commercial Rights & Clean IP">
          <p className="text-sm text-gray-300 leading-relaxed">
            Soundwave AI is built entirely from original code, permissively licensed under the <strong className="text-white">MIT Commercial License</strong>. There is zero proprietary code, zero borrowed assets, and zero third-party dependencies from other creator repositories. You own full commercial rights to sell, package, redistribute, and monetize Soundwave AI and the videos it produces.
          </p>
        </Section>

        <p className="flex items-center gap-2 text-xs text-gray-500">
          <MessageCircleQuestion className="h-4 w-4" /> Soundwave AI Suite · All Rights Reserved · Commercial Version 2.0
        </p>
      </div>
    </div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-card border border-gray-800 bg-panel p-5 sm:p-6">
      <div className="mb-4 flex items-center gap-2">
        <span className="text-cyan-400">{icon}</span>
        <h2 className="text-lg font-semibold text-white">{title}</h2>
      </div>
      {children}
    </div>
  );
}
