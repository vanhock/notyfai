import "dotenv/config";
import express from "express";
import cors from "cors";
import { requireAuth } from "./middleware/auth.js";
import authRouter from "./routes/auth.js";
import hooksRouter from "./routes/hooks.js";
import instancesRouter from "./routes/instances.js";
import devicesRouter from "./routes/devices.js";
import eventsRouter from "./routes/events.js";
import executionsRouter from "./routes/executions.js";
import accountRouter from "./routes/account.js";
import subscriptionsRouter from "./routes/subscriptions.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/auth", authRouter);
app.use("/api/hooks", hooksRouter);
app.use("/api/instances", requireAuth, instancesRouter);
app.use("/api/devices", requireAuth, devicesRouter);
app.use("/api/events", requireAuth, eventsRouter);
app.use("/api/executions", requireAuth, executionsRouter);
app.use("/api/account", requireAuth, accountRouter);
app.use("/api/subscriptions/webhook", subscriptionsRouter);
app.use("/api/subscriptions", requireAuth, subscriptionsRouter);

app.listen(PORT, () => {
  console.log(`Notyfai backend listening on port ${PORT}`);
});
