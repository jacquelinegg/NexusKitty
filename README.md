# NexusKitty — Digital Rights Firewall

A Chrome extension that analyzes Terms of Service and Privacy Policies using AI to highlight risky clauses and empower users to make informed decisions.

## Features

- 🔍 **AI-Powered Analysis**: Uses LLMs to extract risky clauses from ToS/Policy documents.
- 📊 **Safety Score**: Get a quick safety score (0-100) for the terms you're reviewing.
- 📋 **Detailed Findings**: View findings categorized by risk type (Money, Privacy, User Content, AI Usage, Termination).
- 💬 **Ask Kitty**: Ask questions about the terms and get answers with verbatim evidence.
- 💾 **Caching**: Results are cached in Supabase to save API calls and improve speed.
- 🌈 **Cyberpunk Theme**: Dark theme with neon pink and cyan accents for a striking UI.

## Tech Stack

- **Backend**: Python 3.11+, FastAPI, Uvicorn
- **AI/LLM**: OpenAI (gpt-4o-mini) or Anthropic (claude-3-5-sonnet)
- **Database**: Supabase (PostgreSQL)
- **Extension**: Chrome Extension Manifest V3, Vanilla HTML/CSS/JS

## Project Structure

```
nexus-kitty/
├── backend/
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py            # FastAPI entry point & CORS
│   │   ├── config.py          # Environment variables (pydantic-settings)
│   │   ├── database.py        # Supabase client singleton
│   │   ├── schemas.py         # Pydantic models for ToS analysis & API
│   │   ├── prompts.py         # System prompts for ToS AI engine
│   │   └── services/
│   │       ├── llm_service.py # LLM client & response parser
│   │       └── db_service.py  # Supabase CRUD operations
│   ├── requirements.txt
│   └── .env.example
├── extension/
│   ├── manifest.json          # Manifest V3 setup
│   ├── popup/
│   │   ├── popup.html         # Cyberpunk/Anime UI
│   │   ├── popup.css          # Neon/Dark theme styles
│   │   └── popup.js           # Extension frontend logic
│   ├── scripts/
│   │   ├── content.js         # DOM text extractor for ToS pages
│   │   └── background.js      # Service worker & API messenger (to be implemented)
│   └── icons/                 # Extension icon assets
├── database/
│   └── schema.sql             # Supabase DDL migration script
└── README.md
```

## Setup

### Backend

1. Install dependencies:
   ```bash
   cd backend
   pip install -r requirements.txt
   ```

2. Create a `.env` file based on `.env.example` and fill in your API keys and Supabase credentials.

3. Set up the Supabase database by running the `schema.sql` in your Supabase project.

4. Start the backend server:
   ```bash
   uvicorn app.main:app --reload
   ```

### Extension

1. Load the extension in Chrome:
   - Open Chrome and go to `chrome://extensions`
   - Enable "Developer mode"
   - Click "Load unpacked" and select the `extension` directory

2. Visit a Terms of Service or Privacy Policy page, then click the NexusKitty extension icon to see the analysis.

## Usage

1. Navigate to a website's Terms of Service or Privacy Policy page.
2. Click the NexusKitty extension icon in the toolbar.
3. View the safety score, summary, and categorized findings.
4. Use the "Ask Kitty" feature to ask specific questions about the terms.

## Notes

- The extension currently uses `localhost:8000` for the backend. Adjust the `host_permissions` in `manifest.json` if your backend runs on a different URL.
- The content script extracts text from common containers (`<main>`, `<article>`, etc.) and stores it in `localStorage`.
- The popup retrieves the extracted text and sends it to the backend for analysis.

## License

MIT

## Acknowledgments

- Built for LexHack 2026 (Digital Rights & Policy Tech / AI Safety Track)