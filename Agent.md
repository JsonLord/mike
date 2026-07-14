# Deployment Manager Instructions - Hugging Face Space

This file informs agents about deployment best practices and tricks for the `mike` project on Hugging Face Spaces.

## 1. Deployment Configuration

### Target Space
- **Profile:** Leon4gr45
- **Space:** mike
- **Full Identifier:** Leon4gr45/mike
- **Frontend Port:** 7860 (mandatory)

### Deployment Method
- **Docker SDK**: This project uses a custom Dockerfile to run both the Next.js frontend and Express backend.

### HF Token
- The environment variable **`HF_TOKEN`** is used for deployment and monitoring.
- Never hardcode the token in the codebase.

---

## 2. API Exposure

### Mandatory Endpoints
- **`/health`**: Returns HTTP 200 when ready.
- **`/api-docs`**: Documents all available API endpoints. Reachable at `https://Leon4gr45-mike.hf.space/api-docs`.

---

## 3. Deployment Workflow

### Clean & Upload
Before uploading, ensure the Space is clean of unrelated files.
```bash
huggingface-cli ls-files Leon4gr45/mike --repo-type=space
huggingface-cli upload Leon4gr45/mike . --repo-type=space
```

### Monitoring
Build Logs:
```bash
curl -N -H "Authorization: Bearer $HF_TOKEN" "https://huggingface.co/api/spaces/Leon4gr45/mike/logs/build"
```
Run Logs:
```bash
curl -N -H "Authorization: Bearer $HF_TOKEN" "https://huggingface.co/api/spaces/Leon4gr45/mike/logs/run"
```
Wait at least 300 seconds after upload to verify successful transition to 'Running'.
