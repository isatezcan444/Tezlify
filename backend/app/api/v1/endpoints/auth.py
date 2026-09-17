from fastapi import APIRouter

from backend.app.auth.api.routes import router as native_auth_router

router = APIRouter()

# Include native Google OAuth & Session routes (includes /google, /google/callback, /logout, /me)
router.include_router(native_auth_router)

