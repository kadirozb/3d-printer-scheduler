import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.REACT_APP_SUPABASE_URL || 'https://vaogictqghgnrreukvat.supabase.co';
const SUPABASE_ANON_KEY = process.env.REACT_APP_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZhb2dpY3RxZ2hnbnJyZXVrdmF0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4Njc5MDksImV4cCI6MjA5MjQ0MzkwOX0.34f9d7m5mfMLf3mNDjZMbu4Jshoz45vV_dqz7nLFqME';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
