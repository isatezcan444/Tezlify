import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { UserProfile } from '../types';
import { ApiClient } from '../api/client';

interface AuthContextType {
  user: User | null;
  session: Session | null;
  profile: UserProfile | null;
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const fetchOrCreateProfile = useCallback(async (currentUser: User): Promise<UserProfile | null> => {
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
        // Record not found -> Create Starter Profile
        const newProfile = {
          id: currentUser.id,
          email: currentUser.email || '',
          full_name: currentUser.user_metadata?.full_name || currentUser.user_metadata?.name || '',
          avatar_url: currentUser.user_metadata?.avatar_url || currentUser.user_metadata?.picture || '',
          plan_tier: 'STARTER',
          leads_monthly_limit: 50,
          leads_used_this_month: 0,
          messages_daily_limit: 20,
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

      // Fallback in-memory profile if database table not reachable
      return {
        id: currentUser.id,
        email: currentUser.email || '',
        full_name: currentUser.user_metadata?.full_name || currentUser.user_metadata?.name || '',
        avatar_url: currentUser.user_metadata?.avatar_url || currentUser.user_metadata?.picture || '',
        plan_tier: 'STARTER',
        leads_monthly_limit: 50,
        leads_used_this_month: 0,
        messages_daily_limit: 20,
        created_at: new Date().toISOString(),
      };
    } catch (err) {
      console.warn('Could not fetch/create profile, using fallback:', err);
      return {
        id: currentUser.id,
        email: currentUser.email || '',
        full_name: currentUser.user_metadata?.full_name || currentUser.user_metadata?.name || '',
        avatar_url: currentUser.user_metadata?.avatar_url || currentUser.user_metadata?.picture || '',
        plan_tier: 'STARTER',
        leads_monthly_limit: 50,
        leads_used_this_month: 0,
        messages_daily_limit: 20,
        created_at: new Date().toISOString(),
      };
    }
  }, []);

  const refreshProfile = useCallback(async () => {
    if (!user) return;
    const p = await fetchOrCreateProfile(user);
    if (p) setProfile(p);
  }, [user, fetchOrCreateProfile]);

  useEffect(() => {
    // 1. Initial Session Check
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
        const p = await fetchOrCreateProfile(currentUser);
        setProfile(p);
      }
      setLoading(false);
    });

    // 2. Auth State Change Listener
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
        const p = await fetchOrCreateProfile(currentUser);
        setProfile(p);
      } else {
        setProfile(null);
      }
      setLoading(false);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [fetchOrCreateProfile]);

  const signInWithGoogle = async () => {
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: window.location.origin,
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
      await supabase.auth.signOut();
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

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        profile,
        loading,
        signInWithGoogle,
        signOut,
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
