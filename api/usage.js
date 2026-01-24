export default function handler(req, res) {
  res.status(200).json({ usage: 0, limit: 1000, plan: "free" });
}
