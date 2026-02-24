import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import authRoutes from "./routes/auth.routes";
import doctorRoutes from "./routes/doctor.routes";
import appointmentRoutes from "./routes/appointment.routes";
import userRoutes from "./routes/user.routes";
import adminRoutes from "./routes/admin.routes";
import reviewRoutes from "./routes/review.routes";
import notificationRoutes from "./routes/notification.routes";
import aiRoutes from "./routes/ai.routes";
import wellnessRoutes from "./routes/wellness.routes";

const app = express();
const PORT = process.env.PORT || 5000;

// Security Middlewares
app.use(helmet());
app.use(
    cors({
        origin: ["http://localhost:3000", "http://127.0.0.1:3000"],
        credentials: true,
    })
);
app.use(express.json());
app.use(cookieParser());
app.use(morgan("dev"));
app.use("/uploads", express.static("uploads"));

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/doctors", doctorRoutes);
app.use("/api/appointments", appointmentRoutes);
app.use("/api/users", userRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/notifications", notificationRoutes);

// Global Error Handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error(err.stack);
    res.status(500).json({ status: "error", message: err.message || "Internal Server Error" });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
