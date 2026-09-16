import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { UserProfile } from '../types';
import { ApiClient } from '../api/client';

export interface AuthUser {
  id: string;
  email: string;
  is_admin?: boolean;
  user_metadata?: {
    full_name?: string;
    avatar_url?: string;
    name?: string;
    picture?: string;
  };
}

export interface AuthSession {
  token: string;
}

export interface AuthContextType {
  user: AuthUser | any | null;
  session: AuthSession | any | null;
  profile: UserProfile | null;
  loading: boolean;
  isAuthenticated: boolean;
  isAdmin: boolean;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  logout: () => Promise<void>;
  getCurrentUser: () => any;
  getSession: () => any;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  // Oracle Native Auth Profile Fetcher
  const fetchOracleProfile = useCallback(async (token?: string): Promise<UserProfile | null> => {
    try {
      const activeToken =
        token ||
        ApiClient.getAuthToken() ||
        (typeof window !== 'undefined' ? localStorage.getItem('tezlify_session_token') : null);

      const headers: Record<string, string> = {};
      if (activeToken) {
        headers['Authorization'] = `Bearer ${activeToken}`;
        ApiClient.setAuthToken(activeToken);
        setSession({ token: activeToken });
      }

      const res = await fetch('/api/v1/auth/me', { headers, credentials: 'include' });
      if (res.ok) {
        const u = await res.json();
        const authUser: AuthUser = {
          id: u.id,
          email: u.email,
          is_admin: Boolean(u.is_admin),
          user_metadata: {
            full_name: u.full_name,
            avatar_url: u.avatar_url,
          },
        };
        setUser(authUser);

        const p: UserProfile = {
          id: u.id,
          email: u.email,
          full_name: u.full_name || '',
          avatar_url: u.avatar_url || '',
          plan_tier: u.plan_tier || 'STARTER',
          leads_monthly_limit: u.leads_monthly_limit || 50,
          leads_used_this_month: u.leads_used_this_month || 0,
          messages_daily_limit: u.messages_daily_limit || 20,
          created_at: u.created_at || new Date().toISOString(),
          is_admin: Boolean(u.is_admin),
        };
        setProfile(p);
        return p;
      } else if (res.status === 401) {
        // Session invalid or expired
        if (typeof window !== 'undefined') {
          localStorage.removeItem('tezlify_session_token');
        }
        ApiClient.setAuthToken(null);
        setUser(null);
        setSession(null);
        setProfile(null);
      }
    } catch (e) {
      console.warn('[OracleAuth] /me fetch failed:', e);
    }
    return null;
  }, []);

  const refreshProfile = useCallback(async () => {
    await fetchOracleProfile();
  }, [fetchOracleProfile]);

  useEffect(() => {
    // Check URL search parameters for session_token callback from Google OAuth redirect
    const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
    const urlToken = params?.get('session_token');
    const storedToken = typeof window !== 'undefined' ? localStorage.getItem('tezlify_session_token') : null;
    const effectiveToken = urlToken || storedToken || null;

    if (urlToken && typeof window !== 'undefined') {
      localStorage.setItem('tezlify_session_token', urlToken);
      // Clean query parameter from URL without page reload
      const newUrl = window.location.pathname;
      window.history.replaceState({}, '', newUrl);
    }

    if (effectiveToken) {
      ApiClient.setAuthToken(effectiveToken);
      setSession({ token: effectiveToken });
    }

    fetchOracleProfile(effectiveToken || undefined).finally(() => {
      setLoading(false);
    });

    const onWsAuthFailed = () => {
      console.warn('[AuthContext] WS auth failed event received — clearing session');
      ApiClient.setAuthToken(null);
      setSession(null);
      setUser(null);
      setProfile(null);
      if (typeof window !== 'undefined') {
        localStorage.removeItem('tezlify_session_token');
        window.location.reload();
      }
    };
    window.addEventListener('tezlify:ws_auth_failed', onWsAuthFailed);

    return () => {
      window.removeEventListener('tezlify:ws_auth_failed', onWsAuthFailed);
    };
  }, [fetchOracleProfile]);

  const signInWithGoogle = async () => {
    setLoading(true);
    try {
      // Redirect to Oracle backend Google OAuth initiation endpoint
      window.location.href = '/api/v1/auth/google?redirect=true';
    } catch (err) {
      console.error('Google sign in error:', err);
      setLoading(false);
      throw err;
    }
  };

  const signOut = async () => {
    setLoading(true);
    try {
      const activeToken =
        ApiClient.getAuthToken() ||
        (typeof window !== 'undefined' ? localStorage.getItem('tezlify_session_token') : null);
      const headers: Record<string, string> = {};
      if (activeToken) {
        headers['Authorization'] = `Bearer ${activeToken}`;
      }

      await fetch('/api/v1/auth/logout', { method: 'POST', headers, credentials: 'include' });

      if (typeof window !== 'undefined') {
        localStorage.removeItem('tezlify_session_token');
      }
      setUser(null);
      setSession(null);
      setProfile(null);
      ApiClient.setAuthToken(null);
    } catch (err) {
      console.error('Sign out error:', err);
    } finally {
      setLoading(false);
    }
  };

  const isAuthenticated = Boolean(user && (session || profile));

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        profile,
        loading,
        isAuthenticated,
        isAdmin: Boolean(profile?.is_admin || user?.is_admin),
        signInWithGoogle,
        signOut,
        loginWithGoogle: signInWithGoogle,
        logout: signOut,
        getCurrentUser: () => user,
        getSession: () => session,
        refreshProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export default AuthContext;
