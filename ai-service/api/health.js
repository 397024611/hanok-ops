export default async function handler(req, res) {
  res.status(200).json({ ok: true, service: "hanok-ai", version: "0.1.0" });
}
