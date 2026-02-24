# Deploying Near and Now on Railway

This guide covers deploying the **backend** (and optionally the **frontend**) of Near and Now on [Railway](https://railway.app).

You have two approaches:

- **Option A:** Deploy only the backend on Railway and keep the frontend where it is (e.g. nearandnow.in). Set the frontend’s `VITE_API_URL` to your Railway backend URL.
- **Option B:** Deploy both backend and frontend as two Railway services.

---

## Prerequisites

- A [Railway](https://railway.app) account (GitHub login is fine).
- Your repo pushed to GitHub (or connected to Railway via their CLI).

---

## Option A: Backend only on Railway

### 1. Create a new project and service

1. In [Railway](https://railway.app), click **New Project**.
2. Choose **Deploy from GitHub repo** and select `near-and-now`.
3. After the repo is connected, you’ll get one service. We’ll configure it as the **backend**.

### 2. Set root directory and build/start

In the service **Settings**:

| Setting | Value |
|--------|--------|
| **Root Directory** | `backend` |
| **Build Command** | `npm install && npm run build` |
| **Start Command** | `npm run start` |
| **Watch Paths** | `backend/**` (optional; for redeploy on backend changes only) |

Railway sets `PORT` automatically; your backend already uses `process.env.PORT || 3000`, so no code change is needed.

### 3. Environment variables

In the same service, open **Variables** and add (values from your local `.env` or Supabase/Twilio/Google consoles):

**Required:**

- `PORT` – leave unset or leave as Railway’s default (Railway injects it).
- `SUPABASE_URL` – Supabase project URL.
- `SUPABASE_ANON_KEY` – Supabase anon key.
- `SUPABASE_SERVICE_ROLE_KEY` – Supabase service role key (for admin/backend operations).

**If you use Twilio OTP:**

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_SERVICE_SID`

**If you use Google Maps on the backend (places, directions, etc.):**

- `GOOGLE_MAPS_API_KEY` – server-side key (no HTTP referrer restrictions).

### 4. Deploy and get the backend URL

1. Trigger a deploy (push to main or **Deploy** in the dashboard).
2. In **Settings** → **Networking**, add a **Public Domain** (e.g. `near-and-now-api.up.railway.app`).
3. Copy the URL (e.g. `https://near-and-now-api.up.railway.app`). This is your **backend API URL**.

### 5. Point the frontend at the backend

Wherever the frontend is built (e.g. current host for nearandnow.in):

1. Set at **build time**:  
   `VITE_API_URL=https://your-railway-backend-url.up.railway.app`  
   (no trailing slash).
2. Rebuild and redeploy the frontend so the new `VITE_API_URL` is baked in.

The frontend already uses `VITE_API_URL` for API calls; once set and rebuilt, the live site will use the Railway backend.

---

## Option B: Backend + frontend on Railway (two services)

### Service 1: Backend

Same as Option A:

- **Root Directory:** `backend`
- **Build Command:** `npm install && npm run build`
- **Start Command:** `npm run start`
- **Variables:** Same as in Option A.
- **Public domain:** Add one and note the URL (e.g. `https://near-and-now-api.up.railway.app`).

### Service 2: Frontend

1. In the same Railway project, click **New** → **GitHub Repo** and select the same `near-and-now` repo again (or add a service from the same repo).
2. Configure this service as the frontend:

| Setting | Value |
|--------|--------|
| **Root Directory** | `frontend` |
| **Build Command** | `npm install && npm run build` |
| **Start Command** | `npx vite preview --port $PORT` |
| **Watch Paths** | `frontend/**` (optional) |

3. **Variables** for the frontend (so the built app knows the API and Supabase):

   - `VITE_API_URL` = your backend public URL (e.g. `https://near-and-now-api.up.railway.app`) — **must** be set at build time.
   - `VITE_SUPABASE_URL` = same as `SUPABASE_URL`.
   - `VITE_SUPABASE_ANON_KEY` = same as `SUPABASE_ANON_KEY`.
   - Optionally: `VITE_GOOGLE_MAPS_API_KEY`, `VITE_SUPABASE_SERVICE_ROLE_KEY`, etc., if your frontend uses them.

   Important: **Rebuild the frontend service** after changing any `VITE_*` variable, so the new values are embedded in the build.

4. **Public domain:** Add a domain for this service (e.g. `near-and-now.up.railway.app`).

### CORS

The backend uses `app.use(cors())` with no origin restriction, so the frontend domain (e.g. `https://near-and-now.up.railway.app`) can call the API. If you later restrict CORS, add this frontend URL to the allowed origins.

---

## Health check

- Backend: open `https://your-backend-url.up.railway.app/health`. You should see JSON like `{"status":"ok","timestamp":"..."}`.
- Frontend: open the frontend URL and confirm the app loads and that API calls (e.g. login, OTP, orders) go to the Railway backend.

---

## Summary

| Item | Backend (Railway) | Frontend (if on Railway) |
|------|-------------------|--------------------------|
| Root directory | `backend` | `frontend` |
| Build | `npm install && npm run build` | `npm install && npm run build` |
| Start | `npm run start` | `npx vite preview --port $PORT` |
| Key env | `SUPABASE_*`, `TWILIO_*`, `GOOGLE_MAPS_API_KEY` | `VITE_API_URL`, `VITE_SUPABASE_*` |

After deployment, set the live frontend’s `VITE_API_URL` to your Railway backend URL and rebuild so the site uses the backend on Railway.
