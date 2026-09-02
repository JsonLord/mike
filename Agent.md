# Deployment Manager Instructions & Best Practices - Hugging Face Space

This document serves as the guide for deployment managers and automated agents deploying and maintaining the **mike** project on Hugging Face Spaces.

---

## 1. Deployment Configuration

### Target Space
- **Profile:** `Leon4gr45`
- **Space:** `mike`
- **Full Identifier:** `Leon4gr45/mike`
- **Frontend Port:** `7860` (mandatory for Hugging Face Spaces)

### Deployment Method
- **Docker SDK:** The project utilizes a custom multi-stage Dockerfile containing Next.js frontend (port 3000), Express backend (port 3001), and Nginx reverse proxy serving on port 7860.

### HF Token Security
- The Hugging Face API Token must always be read from the environment (e.g., `$HF_TOKEN`).
- **Never hardcode token credentials in repository source files.**

### Required Files
- `Dockerfile` (Configured to expose port 7860 via Nginx)
- `README.md` (Contains Hugging Face YAML metadata header with title, docker sdk, app_port)
- `.hfignore` (Excludes `.git`, `node_modules`, build artifacts, and log files)
- `Agent.md` (This documentation file)

---

## 2. API Exposure and Documentation

### Mandatory Endpoints

- **`/health`**
  - **Method:** GET
  - **Purpose:** Health check returning HTTP 200 `{ "ok": true }`.
  - **URL:** `https://leon4gr45-mike.hf.space/health`

- **`/api-docs`**
  - **Method:** GET
  - **Purpose:** Exposes structured JSON documentation of all active endpoints.
  - **URL:** `https://leon4gr45-mike.hf.space/api-docs`

### Functional Endpoints

All functional endpoints are exposed under `/api/*` (or proxied directly by Nginx):

```
### /health
- Method: GET
- Purpose: Return health status of backend service
- Request: GET /health
- Response: { "ok": true }

### /api-docs
- Method: GET
- Purpose: Retrieve full endpoint directory and schemas
- Request: GET /api-docs
- Response: { "title": "Mike API Documentation", "version": "1.0.0", "endpoints": [...] }

### /chat
- Method: POST
- Purpose: Run AI chat model inference and manage chat sessions
- Request Example:
  {
    "message": "Summarize this document",
    "model": "gpt-4o"
  }
- Response Example:
  {
    "id": "chat_123",
    "response": "Summary..."
  }

### /projects
- Method: GET / POST / PATCH / DELETE
- Purpose: Create and manage analysis projects
- Request Example (POST):
  {
    "title": "Legal Case Review"
  }
- Response Example:
  {
    "id": "proj_456",
    "title": "Legal Case Review"
  }

### /projects/:projectId/chat
- Method: POST
- Purpose: Project-scoped AI chat inference
- Request Example:
  {
    "message": "Analyze project documents"
  }

### /single-documents
- Method: GET / POST / DELETE
- Purpose: Upload and manage standalone documents
- Request Example (POST): multipart/form-data document upload

### /tabular-review
- Method: GET / POST / PATCH / DELETE
- Purpose: Tabular data extraction and structured review generation
- Request Example (POST):
  {
    "title": "Clause Matrix Review"
  }

### /tabular-review/:reviewId/generate
- Method: POST
- Purpose: Trigger bulk analysis column generation across review items

### /workflows
- Method: GET / POST / PATCH / DELETE
- Purpose: Create, manage, and share automated document review workflows

### /user
- Method: GET / PATCH
- Purpose: Retrieve and update user profile and configuration settings

### /user/api-keys
- Method: GET / PUT
- Purpose: Configure custom provider API keys (OpenAI, Anthropic, etc.)

### /download
- Method: GET
- Purpose: Download generated reports and documents
```

---

## 3. Deployment Workflow & Ongoing Best Practices

### Pre-Deployment Clean-Up
Before uploading code to the Hugging Face Space, verify remote repo contents to prevent stale artifacts (such as previous `node_modules` uploads):

```bash
# Check remote repository files
python3 -c "
from huggingface_hub import HfApi
api = HfApi(token='<HF_TOKEN>')
print(api.list_repo_files(repo_id='Leon4gr45/mike', repo_type='space'))
"
```

### Uploading Codebase
To deploy to Hugging Face Space:

```bash
hf upload Leon4gr45/mike . --repo-type=space --token $HF_TOKEN
```

### Log Monitoring Loop
1. Stream build logs:
```bash
curl -N -H "Authorization: Bearer $HF_TOKEN" "https://huggingface.co/api/spaces/Leon4gr45/mike/logs/build"
```
2. Once build succeeds, stream runtime logs:
```bash
curl -N -H "Authorization: Bearer $HF_TOKEN" "https://huggingface.co/api/spaces/Leon4gr45/mike/logs/run"
```
3. Wait up to 300 seconds for state transition to **RUNNING**.
4. Verify HTTP 200 response from health & api-docs endpoints:
```bash
curl -f https://leon4gr45-mike.hf.space/health
curl -f https://leon4gr45-mike.hf.space/api-docs
```
5. If any failure occurs, inspect logs, apply codebase fixes, and re-run deployment.
