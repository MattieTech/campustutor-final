# 📚 StudyMind AI

> An AI-powered study assistant that transforms your PDF lecture notes into
> summaries, explanations, revision questions, and flashcards.

**Tech Stack:** Node.js + Express · Supabase · Google Gemini AI · HTML/CSS/JS · Vercel

---

## 🗂️ Project Structure

```
studymind-ai/
│
├── vercel.json              ← Tells Vercel how to deploy your app
├── .gitignore               ← Files Git should NOT track (like .env)
│
├── backend/                 ← Node.js server (the brain of the app)
│   ├── server.js            ← Main Express server (entry point)
│   ├── package.json         ← Node.js dependencies list
│   ├── .env.example         ← Template for your .env file
│   │
│   ├── routes/              ← Route handlers (each file = a group of URLs)
│   │   ├── auth.js          ← POST /api/auth/signup, /login, /logout
│   │   ├── upload.js        ← POST /api/upload/pdf, GET /api/upload/my-docs
│   │   └── ai.js            ← POST /api/ai/summarize, /explain, /questions, /flashcards
│   │
│   ├── middleware/
│   │   └── authMiddleware.js ← JWT token verification (protects private routes)
│   │
│   └── utils/
│       ├── supabase.js      ← Supabase database client
│       └── gemini.js        ← Google Gemini AI client
│
└── frontend/                ← HTML/CSS/JS (what users see in the browser)
    ├── index.html           ← Landing page (public)
    ├── css/
    │   └── style.css        ← All styles (dark theme, components)
    ├── js/
    │   └── api.js           ← Frontend API functions (fetch wrappers)
    └── pages/
        ├── login.html       ← Login form
        ├── signup.html      ← Signup form
        ├── dashboard.html   ← Document list & stats
        ├── upload.html      ← PDF upload page
        └── study.html       ← AI tools interface
```

---

## 🔄 How Everything Connects

```
BROWSER (Frontend HTML/JS)
       ↓  fetch() with JWT token
    /api/upload/pdf
       ↓
BACKEND (Express server.js)
       ↓  authMiddleware checks JWT
    routes/upload.js
       ↓  pdf-parse extracts text
    Supabase (save document)
       ↓
    Return { documentId, extractedText }
       ↓
BROWSER clicks "Summarize"
       ↓  POST /api/ai/summarize { documentId }
BACKEND routes/ai.js
       ↓  fetch text from Supabase
    utils/gemini.js
       ↓  askGemini(prompt + text)
GOOGLE GEMINI API
       ↓  returns summary text
BACKEND saves to Supabase ai_results
       ↓  returns { summary }
BROWSER displays the summary ✨
```

---

## ⚙️ STEP 1 — Supabase Setup

1. Go to **https://supabase.com** and create a free account
2. Click **"New Project"**, give it a name like `studymind-ai`
3. Choose a region close to Nigeria (e.g. West EU or US East)
4. Wait ~2 minutes for the project to be created

### Create the Database Tables

Go to your Supabase project → **SQL Editor** → click **"New Query"** → paste and run:

```sql
-- Table 1: User profiles (extra info beyond what Supabase Auth stores)
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table 2: Uploaded documents
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  extracted_text TEXT,
  page_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table 3: AI-generated results (cached to avoid re-generating)
CREATE TABLE ai_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  result_type TEXT NOT NULL,  -- 'summary', 'explanation', 'questions', 'flashcards'
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(document_id, result_type)  -- One result per type per document
);

-- Row Level Security (RLS) — users can only see their own data
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_results ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can manage their own profile"
  ON profiles FOR ALL USING (auth.uid() = id);

CREATE POLICY "Users can manage their own documents"
  ON documents FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users can manage their own AI results"
  ON ai_results FOR ALL USING (auth.uid() = user_id);
```

### Get Your Supabase Keys

Go to **Settings → API** in your Supabase project:
- Copy **Project URL** → this is your `SUPABASE_URL`
- Copy **service_role** key (NOT the anon key!) → this is your `SUPABASE_SERVICE_KEY`

⚠️ **IMPORTANT**: The `service_role` key is secret and powerful — never put it in frontend code!

---

## 🤖 STEP 2 — Get Your Gemini API Key

1. Go to **https://aistudio.google.com/app/apikey**
2. Sign in with your Google account
3. Click **"Create API key"**
4. Copy the key (starts with `AIza...`)

The free tier gives you **15 requests per minute** and **1 million tokens per day** — more than enough for a student app!

---

## 💻 STEP 3 — Local Setup

### Prerequisites
- Install **Node.js** (v18+): https://nodejs.org/en/download
- Install **Git**: https://git-scm.com/downloads
- A code editor like **VS Code**: https://code.visualstudio.com

### Install Dependencies

```bash
# Open terminal, navigate to the backend folder
cd studymind-ai/backend

# Install all Node.js packages listed in package.json
npm install
```

### Create Your .env File

```bash
# In the backend/ folder, create a .env file
# (Copy from .env.example)
cp .env.example .env
```

Open `.env` and fill in your real values:

```env
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_SERVICE_KEY=eyJ...your-service-role-key...
GEMINI_API_KEY=AIza...your-gemini-key...
PORT=3000
FRONTEND_URL=http://localhost:3000
```

### Run the Development Server

```bash
# Start the server (from the backend/ folder)
npm run dev

# You should see:
# ✅ StudyMind AI server running on http://localhost:3000
```

Open **http://localhost:3000** in your browser — you should see the landing page!

---

## 🚀 STEP 4 — Deploy to Vercel

### Prerequisites
- Push your code to GitHub first (required by Vercel):

```bash
# In the root studymind-ai/ folder:
git init
git add .
git commit -m "Initial StudyMind AI commit"

# Create a repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/studymind-ai.git
git push -u origin main
```

### Deploy

1. Go to **https://vercel.com** and sign up (free)
2. Click **"New Project"**
3. Import your GitHub repository
4. **IMPORTANT**: Set the Root Directory to `.` (the project root, where `vercel.json` is)
5. Click **"Environment Variables"** and add all four:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
   - `GEMINI_API_KEY`
   - `FRONTEND_URL` → set this to your Vercel URL (e.g. `https://studymind-ai.vercel.app`)
6. Click **"Deploy"**

Vercel will build and deploy automatically in ~1 minute!

### Update CORS After Deployment

After you get your Vercel URL, update `FRONTEND_URL` in Vercel's environment variables
to match your actual URL (e.g. `https://studymind-ai.vercel.app`), then **redeploy**.

---

## 🧪 Testing the App

1. Open your app URL
2. Click **"Get Started Free"** → Create an account
3. Log in
4. Upload a PDF (try a class note or any text-based PDF)
5. Click **"Summarize Notes"** → wait ~10 seconds → you'll see the summary!
6. Try "Create Flashcards" → click each card to flip it
7. Type a concept in the "Explain" box → get a simple explanation

---

## 🛠️ Common Issues & Fixes

| Problem | Fix |
|---------|-----|
| `Cannot find module` | Run `npm install` in the `backend/` folder |
| `Missing SUPABASE_URL` | Check your `.env` file has all 4 variables |
| `PDF has no readable text` | Use a text-based PDF, not a scanned image |
| `Gemini API error` | Check your API key, check your internet, try again |
| `401 Unauthorized` | You're not logged in, or your session expired — log in again |
| CORS error in browser | Make sure `FRONTEND_URL` in `.env` matches where your frontend runs |

---

## 🎓 What You Learned Building This

- **Express.js** — routing, middleware, error handling
- **REST APIs** — designing and building HTTP endpoints
- **JWT Authentication** — how tokens secure private routes
- **File uploads** — Multer, FormData, multipart encoding
- **Database design** — Supabase tables, foreign keys, RLS
- **AI integration** — calling the Gemini API with prompts
- **Environment variables** — keeping secrets secure
- **Vercel deployment** — shipping a real full-stack app

---

*Built with ❤️ · Powered by Google Gemini · Deployed on Vercel*
