"""
Soundwave AI — LLM Client & Tool Orchestrator
Connects to Google Gemini (2.0/1.5 Flash), OpenRouter, or local Ollama with autonomous tool execution.
Includes a fast, offline intent parser when no API key is configured.
"""

import os
import re
import json
import urllib.request
import urllib.parse
from typing import Dict, Any, List, Optional, Tuple

from memory.config_manager import config_manager
from memory.memory_manager import memory_manager
from core.action_loader import action_registry
from core.undo import undo_manager

SYSTEM_PROMPT = """You are Soundwave, a real-time autonomous voice AI and desktop assistant.
You control the user's computer using your declared tools.
You are fast, helpful, concise, and focused. Keep spoken replies punchy and natural (1-3 sentences) unless asked for deep detail.
When asked to create videos or shorts, use the soundwave_shorts action.
When asked to open apps, search the web, check weather, adjust settings, or manage files, use your tools.
Always prioritize the user's preferences stored in your memory."""

class LLMClient:
    def __init__(self):
        if not action_registry.actions:
            action_registry.discover_actions()

    def get_provider(self) -> Tuple[str, str]:
        """Return (provider_name, api_key)."""
        gemini_key = config_manager.get_api_key("gemini") or os.environ.get("GEMINI_API_KEY", "")
        if gemini_key:
            return "gemini", gemini_key

        openrouter_key = config_manager.get_api_key("openrouter") or os.environ.get("OPENROUTER_API_KEY", "")
        if openrouter_key:
            return "openrouter", openrouter_key

        openai_key = config_manager.get_api_key("openai") or os.environ.get("OPENAI_API_KEY", "")
        if openai_key:
            return "openai", openai_key

        return "local", ""

    def query(self, user_prompt: str, history: Optional[List[Dict[str, str]]] = None) -> Tuple[str, Optional[str]]:
        """
        Process user query through Gemini/LLM with tool execution.
        Returns: (spoken_reply, optional_action_output)
        """
        provider, api_key = self.get_provider()

        if provider == "gemini" and api_key:
            try:
                return self._query_gemini(user_prompt, api_key, history)
            except Exception as e:
                print(f"[LLM] Gemini request failed ({e}); falling back to local orchestrator.")

        elif provider in ("openrouter", "openai") and api_key:
            try:
                return self._query_openai_compatible(user_prompt, provider, api_key, history)
            except Exception as e:
                print(f"[LLM] {provider} request failed ({e}); falling back to local orchestrator.")

        # Offline local intent parser fallback (zero API key needed)
        return self._local_intent_orchestrator(user_prompt)

    def _query_gemini(self, user_prompt: str, api_key: str, history: Optional[List[Dict[str, str]]] = None) -> Tuple[str, Optional[str]]:
        """Call Gemini API with function calling declarations."""
        model = "gemini-1.5-flash"
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"

        # Inject memory facts into context
        facts = memory_manager.get_facts()
        memory_context = "\n".join(f"- {f}" for f in facts[-5:]) if facts else "No facts recorded."
        full_system = f"{SYSTEM_PROMPT}\n\nUser Context:\n{memory_context}"

        # Build tools schema for Gemini
        tools_list = action_registry.list_tools()
        function_declarations = []
        for t in tools_list:
            function_declarations.append({
                "name": t["name"],
                "description": t["description"],
                "parameters": t.get("parameters", {"type": "OBJECT", "properties": {}})
            })

        payload = {
            "system_instruction": {"parts": [{"text": full_system}]},
            "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
            "tools": [{"function_declarations": function_declarations}]
        }

        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"}
        )

        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))

        candidates = data.get("candidates", [])
        if not candidates:
            return "I didn't receive a response from Gemini.", None

        parts = candidates[0].get("content", {}).get("parts", [])
        text_replies = []
        tool_results = []

        for p in parts:
            if "text" in p:
                text_replies.append(p["text"])
            elif "functionCall" in p:
                fn_call = p["functionCall"]
                fn_name = fn_call.get("name")
                fn_args = fn_call.get("args", {})
                res = action_registry.execute(fn_name, fn_args)
                tool_results.append(f"[{fn_name}]: {res}")

        final_text = " ".join(text_replies) if text_replies else "Action completed."
        final_tool_output = "\n".join(tool_results) if tool_results else None
        return final_text, final_tool_output

    def _query_openai_compatible(self, user_prompt: str, provider: str, api_key: str, history: Optional[List[Dict[str, str]]]) -> Tuple[str, Optional[str]]:
        base_url = "https://openrouter.ai/api/v1/chat/completions" if provider == "openrouter" else "https://api.openai.com/v1/chat/completions"
        model = "google/gemini-2.0-flash-001" if provider == "openrouter" else "gpt-4o-mini"

        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt}
        ]

        payload = {"model": model, "messages": messages, "max_tokens": 250}
        req = urllib.request.Request(
            base_url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        )

        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))

        content = data["choices"][0]["message"]["content"]
        return content, None

    def _local_intent_orchestrator(self, user_prompt: str) -> Tuple[str, Optional[str]]:
        """Intelligent offline pattern parser for immediate zero-API-key action execution."""
        q = user_prompt.lower().strip()

        # 0. Ghost Operator Macros & Chained Workflows
        if any(w in q for w in ["morning prep", "start my day", "daily routine", "creator setup"]):
            res = action_registry.execute("ghost_macro", {"action": "execute", "macro_id": "creator_morning_prep"})
            return "Running Creator Workstation Setup: browser launched, volume adjusted, vitals verified.", res

        if any(w in q for w in ["run macro", "ghost operator", "automation macro"]):
            m_id = "creator_morning_prep"
            if "viral" in q or "short" in q:
                m_id = "viral_production_autopilot"
            elif "diag" in q or "clean" in q:
                m_id = "workspace_cleanup_diagnostics"
            res = action_registry.execute("ghost_macro", {"action": "execute", "macro_id": m_id})
            return f"Ghost Operator executing macro '{m_id}'.", res

        # 1. Shorts & Video Creation
        if any(w in q for w in ["short", "video", "tiktok", "reel", "viral"]):
            if "batch" in q or "all" in q:
                res = action_registry.execute("soundwave_shorts", {"action": "batch"})
                return "Starting batch generation across all 7 viral niches now.", res
            else:
                niche = "psychology"
                for n in ["facts", "history", "finance", "ai", "motivation", "horror"]:
                    if n in q:
                        niche = n
                        break
                res = action_registry.execute("soundwave_shorts", {"action": "single", "niche": niche})
                return f"Creating a viral short for {niche.title()} with dynamic subtitles.", res

        # 2. Open Applications
        if q.startswith("open ") or q.startswith("launch ") or q.startswith("start "):
            app_target = re.sub(r"^(open|launch|start)\s+", "", q).strip()
            res = action_registry.execute("open_app", {"app_name": app_target})
            return f"Opening {app_target} for you.", res

        # 3. Weather
        if "weather" in q or "temperature" in q:
            m = re.search(r"in\s+([a-zA-Z\s]+)", q)
            city = m.group(1).strip() if m else "Belgrade"
            res = action_registry.execute("weather_report", {"city": city})
            return f"Here is the current weather: {res}", res

        # 4. System Telemetry
        if any(w in q for w in ["cpu", "ram", "memory", "battery", "system", "stats"]):
            res = action_registry.execute("system_monitor", {"query": "all"})
            return "Here are your current system vitals.", res

        # 5. Screen Capture / Vision / Screen Recording
        if any(w in q for w in ["record screen", "screen recorder", "record my screen", "creator studio"]):
            res = action_registry.execute("screen_processor", {"action": "record"})
            return "Launching Creator Studio Smart Screen Recorder.", res

        if any(w in q for w in ["screenshot", "screen", "see", "look"]):
            res = action_registry.execute("screen_processor", {"action": "capture"})
            return "I captured your screen display.", res

        # 6. Volume & Settings
        if "mute" in q:
            res = action_registry.execute("computer_settings", {"setting": "mute"})
            return "Toggled system audio mute.", res
        if "volume" in q:
            m = re.search(r"(\d+)", q)
            val = int(m.group(1)) if m else 50
            res = action_registry.execute("computer_settings", {"setting": "volume", "value": val})
            return f"Adjusted volume to {val}%.", res

        # 7. Clipboard
        if "clipboard" in q or "copy" in q:
            res = action_registry.execute("clipboard", {"operation": "get"})
            return f"Your clipboard contents: {res}", res

        # 8. Reminders & Timers
        if "remind" in q or "timer" in q:
            res = action_registry.execute("reminder", {"message": "Scheduled reminder", "seconds": 60})
            return "Timer set for 60 seconds.", res

        # 9. Web Search
        if q.startswith("search ") or q.startswith("google ") or q.startswith("who ") or q.startswith("what "):
            res = action_registry.execute("web_search", {"query": q})
            return "Searching the web for the answer.", res

        # 10. Proactive Briefing
        if any(w in q for w in ["proactive", "briefing", "vitals", "status check", "check-in"]):
            res = action_registry.execute("proactive", {})
            return "Here is your system briefing.", res

        # 11. YouTube Search & Play
        if "youtube" in q or "play video" in q:
            target = re.sub(r"(youtube|play|video|watch)", "", q).strip() or "trending tech"
            res = action_registry.execute("youtube_video", {"query": target})
            return f"Playing YouTube video for {target}.", res

        # 12. Code Sandbox Execution
        if "python" in q or "code" in q or "run script" in q:
            code = re.sub(r"^(run|execute|eval)?\s*(python|code)?\s*:", "", q).strip()
            res = action_registry.execute("code_helper", {"code": code or "print('Soundwave Sandbox: Active')"})
            return "Executed sandboxed Python script.", res

        # 13. Browser Navigation
        if "browse" in q or "navigate" in q or "url" in q:
            m = re.search(r"https?://\S+", q)
            url = m.group(0) if m else "https://google.com"
            res = action_registry.execute("browser_control", {"action": "open", "url": url})
            return f"Navigating to {url}.", res

        # 14. Document / File Processing
        if "file" in q or "document" in q or "read text" in q:
            res = action_registry.execute("file_processor", {"action": "list", "path": "."})
            return "Inspected directory files.", res

        # 15. Default General Conversation
        assistant_name = config_manager.get_assistant_name()
        return (
            f"I am {assistant_name}. I can control your computer, search the web, capture your screen, adjust system settings, and generate viral shorts. Ask me to do anything!",
            None
        )

llm_client = LLMClient()
