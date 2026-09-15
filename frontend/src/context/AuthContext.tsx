import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { UserProfile } from '../types';
import { ApiClient, setTokenRefresher } from '../api/client';

export interface AuthContextType {
  user: User | any | null;
  session: Session | any | null;
  profile: UserProfile | null;
  loading: boolean;
  isAuthenticated: boolean;
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
  const [user, setUser] = useState<any | null>(null);
  const [session, setSession] = useState<any | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const authProvider = import.meta.env.VITE_AUTH_PROVIDER || 'supabase';

  // --- SUPABASE AUTH FLOW (Default / Rollback) ---
  const fetchOrCreateProfileSupabase = useCallback(async (currentUser: User): Promise<UserProfile | null> => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', currentUser.id)
        .single();

      if (data) {
        return data as UserProfile;
      }

      if (error && error.code === 'PGRST116') {
        const newProfile = {
          id: currentUser.id,
          email: currentUser.email || '',
          full_name: currentUser.user_metadata?.full_name || currentUser.user_metadata?.name || '',
          avatar_url: currentUser.user_metadata?.avatar_url || currentUser.user_metadata?.picture || '',
          plan_tier: 'DEVELOPER_PRO',
          leads_monthly_limit: 999999,
          leads_used_this_month: 0,
          messages_daily_limit: 999999,
        };

        const { data: inserted, error: insertError } = await supabase
          .from('profiles')
          .insert([newProfile])
          .select()
          .single();

        if (!insertError && inserted) {
          return inserted as UserProfile;
        }
      }

      return {
        id: currentUser.id,
        email: currentUser.email || '',
        full_name: currentUser.user_metadata?.full_name || currentUser.user_metadata?.name || '',
        avatar_url: currentUser.user_metadata?.avatar_url || currentUser.user_metadata?.picture || '',
        plan_tier: 'DEVELOPER_PRO',
        leads_monthly_limit: 999999,
        leads_used_this_month: 0,
        messages_daily_limit: 999999,
        created_at: new Date().toISOString(),
      };
    } catch (err) {
      console.warn('Could not fetch/create profile, using fallback:', err);
      return {
        id: currentUser.id,
        email: currentUser.email || '',
        full_name: currentUser.user_metadata?.full_name || currentUser.user_metadata?.name || '',
        avatar_url: currentUser.user_metadata?.avatar_url || currentUser.user_metadata?.picture || '',
        plan_tier: 'DEVELOPER_PRO',
        leads_monthly_limit: 999999,
        leads_used_this_month: 0,
        messages_daily_limit: 999999,
        created_at: new Date().toISOString(),
      };
    }
  }, []);

  // --- ORACLE NATIVE AUTH FLOW (Staging / Cutover) ---
  const fetchOracleProfile = useCallback(async (token?: string): Promise<UserProfile | null> => {
    try {
      const headers: Record<string, string> = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      const res = await fetch('/api/v1/auth/me', { headers, credentials: 'include' });
      if (res.ok) {
        const u = await res.json();
        setUser({ id: u.id, email: u.email, user_metadata: { full_name: u.full_name, avatar_url: u.avatar_url } });
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
        };
        setProfile(p);
        return p;
      }
    } catch (e) {
      console.warn('[OracleAuth] /me fetch failed:', e);
    }
    return null;
  }, []);

  const refreshProfile = useCallback(async () => {
    if (authProvider === 'oracle') {
      await fetchOracleProfile();
    } else {
      if (!user) return;
      const p = await fetchOrCreateProfileSupabase(user);
      if (p) setProfile(p);
    }
  }, [user, authProvider, fetchOracleProfile, fetchOrCreateProfileSupabase]);

  useEffect(() => {
    if (authProvider === 'oracle') {
      // Check query param for session_token callback
      const params = new URLSearchParams(window.location.search);
      const urlToken = params.get('session_token');
      if (urlToken) {
        ApiClient.setAuthToken(urlToken);
        setSession({ token: urlToken });
        // Clean URL query param without reload
        const newUrl = window.location.pathname;
        window.history.replaceState({}, '', newUrl);
      }

      fetchOracleProfile(urlToken || undefined).finally(() => {
        setLoading(false);
      });
      return;
    }

    // Default Supabase Flow
    setTokenRefresher(async () => {
      try {
        const { data, error } = await supabase.auth.refreshSession();
        if (error || !data?.session?.access_token) return null;
        ApiClient.setAuthToken(data.session.access_token);
        return data.session.access_token;
      } catch {
        return null;
      }
    });

    supabase.auth.getSession().then(async ({ data: { session: initialSession } }) => {
      setSession(initialSession);
      const currentUser = initialSession?.user ?? null;
      setUser(currentUser);
      if (initialSession?.access_token) {
        ApiClient.setAuthToken(initialSession.access_token);
      } else {
        ApiClient.setAuthToken(null);
      }

      if (currentUser) {
        const p = await fetchOrCreateProfileSupabase(currentUser);
        setProfile(p);
      }
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (_event, newSession) => {
      setSession(newSession);
      const currentUser = newSession?.user ?? null;
      setUser(currentUser);

      if (newSession?.access_token) {
        ApiClient.setAuthToken(newSession.access_token);
      } else {
        ApiClient.setAuthToken(null);
      }

      if (currentUser) {
        const p = await fetchOrCreateProfileSupabase(currentUser);
        setProfile(p);
      } else {
        setProfile(null);
      }
      setLoading(false);
    });

    const onWsAuthFailed = () => {
      console.warn('[AuthContext] WS auth failed event received — clearing session');
      ApiClient.setAuthToken(null);
      setSession(null);
      setUser(null);
      setProfile(null);
      if (typeof window !== 'undefined') {
        window.location.reload();
      }
    };
    window.addEventListener('tezlify:ws_auth_failed', onWsAuthFailed);

    return () => {
      subscription.unsubscribe();
      setTokenRefresher(null);
      window.removeEventListener('tezlify:ws_auth_failed', onWsAuthFailed);
    };
  }, [authProvider, fetchOracleProfile, fetchOrCreateProfileSupabase]);

  const signInWithGoogle = async () => {
    setLoading(true);
    try {
      if (authProvider === 'oracle') {
        // Redirect to Oracle backend Google OAuth endpoint
        window.location.href = '/api/v1/auth/google?redirect=true';
        return;
      }

      const redirectUrl =
        typeof window !== 'undefined' && window.location.hostname.includes('vercel.app')
          ? window.location.origin
          : 'https://tezlify-woad.vercel.app';

      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: redirectUrl,
          queryParams: {
            access_type: 'offline',
            prompt: 'consent',
          },
        },
      });
      if (error) throw error;
    } catch (err) {
      console.error('Google sign in error:', err);
      setLoading(false);
      throw err;
    }
  };

  const signOut = async () => {
    setLoading(true);
    try {
      if (authProvider === 'oracle') {
        await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'include' });
      } else {
        await supabase.auth.signOut();
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
