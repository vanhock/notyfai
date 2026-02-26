import "dotenv/config";
import express from "express";
import { requireAuth } from "./middleware/auth.js";
import authRouter from "./routes/auth.js";
import hooksRouter from "./routes/hooks.js";
import instancesRouter from "./routes/instances.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/auth", authRouter);
app.use("/api/hooks", hooksRouter);
app.use("/api/instances", requireAuth, instancesRouter);

app.listen(PORT, () => {
  console.log(`Notyfai backend listening on port ${PORT}`);
});
