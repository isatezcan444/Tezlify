import { createClient } from '@supabase/supabase-js';

const supabaseUrl =
  import.meta.env.VITE_SUPABASE_URL || 'https://qfypckopgelvsimfrfub.supabase.co';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

if (!supabaseAnonKey && import.meta.env.PROD) {
  console.warn('[Supabase] VITE_SUPABASE_ANON_KEY is not defined in production environment.');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey || 'dummy-anon-key-placeholder', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
