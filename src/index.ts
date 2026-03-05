import express from "express";
import identifyRouter from "./routes/identify";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Health check
app.get("/", (_req, res) => {
    res.json({
        message: "Bitespeed Identity Reconciliation Service",
        status: "running",
        endpoint: "POST /identify",
    });
});

// Identity reconciliation endpoint
app.use("/identify", identifyRouter);
// Only listen when running locally (not on Vercel serverless)
if (!process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
    });
}

export default app;
