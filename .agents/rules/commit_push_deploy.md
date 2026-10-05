# Post-Development Rule: Commit, Push & Deploy

## Mandatory Development Lifecycle Invariant
For every completed feature, bugfix, or enhancement in this repository, the agent MUST execute the following pipeline in order before marking the task complete:

1. **Verification & Build Testing**:
   - Backend tests must pass: `source venv/bin/activate && PYTHONPATH=. pytest backend/tests/ -v`
   - Frontend build must pass: `cd frontend && npm run build`
   - Gateway tests (if modified): `cd whatsapp-gateway && npm test`

2. **Git Commit**:
   - Stage all relevant changes (`git add`).
   - Create a clean, conventional commit message detailing what was implemented/fixed (`git commit -m "feat/fix(...): ..."`).

3. **Git Push**:
   - Push commits to the remote tracking branch: `git push origin <branch>` (usually `git push origin main`).

4. **Production Deployment**:
   - Trigger the automated release orchestration script:
     ```bash
     bash scripts/deploy/release.sh
     ```
   - Verify deployment logs and ensure public endpoints (`/health` and live assets) return 200 OK without drift.
