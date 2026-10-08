import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { createAccountHandler } from "./handler.mjs";

Deno.serve(createAccountHandler({ createClient, env: (name: string) => Deno.env.get(name) }));
