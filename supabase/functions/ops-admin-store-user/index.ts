import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://baogaolaoban-report.vercel.app",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin");
  if (origin && origin !== corsHeaders["Access-Control-Allow-Origin"]) return json({ error: "Origin not allowed" }, 403);
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Unauthorized" }, 401);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await caller.auth.getUser();
  if (userError || !userData.user) return json({ error: "Unauthorized" }, 401);

  const { data: profile } = await admin
    .from("ops_profiles")
    .select("role,active")
    .eq("user_id", userData.user.id)
    .maybeSingle();

  if (profile?.role !== "admin" || profile?.active !== true) return json({ error: "Admin only" }, 403);

  let payload: any;
  try { payload = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const storeCode = String(payload.storeCode || "").toUpperCase().trim();
  const password = String(payload.password || "");
  if (!/^[A-Z0-9]{2,8}$/.test(storeCode)) return json({ error: "Invalid store code" }, 400);
  if (Array.from(password).length < 8 || new TextEncoder().encode(password).byteLength > 72) return json({ error: "invalid_password" }, 400);

  const { data: store, error: storeError } = await admin
    .from("ops_stores")
    .select("id,code,name")
    .eq("code", storeCode)
    .eq("active", true)
    .single();
  if (storeError || !store) return json({ error: "Store not found" }, 404);

  const internalEmail = `store.${store.code.toLowerCase()}@hanokops.invalid`;

  // Compatibility reset only: this route cannot create, repurpose, or reactivate accounts.
  // The migration marks the five pre-existing shared logins explicitly.
  const { data: shared, error: sharedError } = await admin.from("ops_profiles")
    .select("user_id,email,role,active,is_legacy_shared,store_id")
    .eq("email", internalEmail).eq("store_id", store.id).maybeSingle();
  if (sharedError) return json({ error: "Account lookup failed" }, 503);
  if (!shared || !shared.active || !shared.is_legacy_shared || shared.role !== "store") {
    return json({ error: "Existing active shared store account required" }, 409);
  }
  const { data: authData, error: authError } = await admin.auth.admin.getUserById(shared.user_id);
  if (authError || authData.user?.email?.toLowerCase() !== internalEmail) {
    return json({ error: "Shared account identity mismatch" }, 409);
  }
  const { error: resetError } = await admin.auth.admin.updateUserById(shared.user_id, { password });
  if (resetError) return json({ error: "Could not reset shared account password" }, 503);

  return json({
    ok: true,
    username: store.name,
    storeCode: store.code,
    message: "Store account is ready",
  });
});