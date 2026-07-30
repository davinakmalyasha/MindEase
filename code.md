# Technical Architecture & Blueprint: MindEase Migration (Go + Next.js + MySQL)

This document details the code structure, database design, and architectural patterns for the MindEase platform migration. It strictly implements the global development guidelines including **SRP (<80-100 lines per file)**, **Strict Layering**, **Zero Frontend Trust**, and **Database ID Masking (UUID-only exposure)**.

---

## 1. Database Schema Design (MySQL DDL)

To protect the system from enumeration attacks and comply with **"NEVER leak DB internal IDs"**, the schema uses auto-incrementing `BIGINT UNSIGNED` columns as primary keys internally for performance and indexing, while mapping each record to a binary UUIDv7 or UUIDv4 for public exposure. 

```sql
-- Disable foreign key checks during migration
SET FOREIGN_KEY_CHECKS = 0;

-- 1. Users Table
CREATE TABLE `users` (
    `id` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    `uuid` BINARY(16) NOT NULL UNIQUE,
    `email` VARCHAR(255) NOT NULL UNIQUE,
    `password_hash` VARCHAR(255) NULL, -- Nullable for Google Auth users
    `name` VARCHAR(255) NOT NULL,
    `avatar_url` VARCHAR(512) NULL,
    `role` ENUM('patient', 'doctor', 'admin') NOT NULL DEFAULT 'patient',
    `phone_number` VARCHAR(50) NULL,
    `provider` VARCHAR(50) NOT NULL DEFAULT 'local',
    `google_id` VARCHAR(255) NULL UNIQUE,
    `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX `idx_users_email` (`email`),
    INDEX `idx_users_uuid` (`uuid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Doctors Table
CREATE TABLE `doctors` (
    `id` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    `uuid` BINARY(16) NOT NULL UNIQUE,
    `user_id` BIGINT UNSIGNED NOT NULL UNIQUE,
    `specialty` VARCHAR(255) NOT NULL,
    `bio` TEXT NOT NULL,
    `experience_years` INT UNSIGNED NOT NULL DEFAULT 0,
    `average_rating` DECIMAL(3,2) NOT NULL DEFAULT 5.00,
    `consultation_price` INT UNSIGNED NOT NULL DEFAULT 0,
    `availability_status` VARCHAR(50) NOT NULL DEFAULT 'Available',
    `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
    INDEX `idx_doctors_uuid` (`uuid`),
    INDEX `idx_doctors_specialty` (`specialty`),
    INDEX `idx_doctors_price` (`consultation_price`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Consultation Slots Table
CREATE TABLE `consultation_slots` (
    `id` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    `uuid` BINARY(16) NOT NULL UNIQUE,
    `doctor_id` BIGINT UNSIGNED NOT NULL,
    `slot_date` DATE NOT NULL,
    `start_time` TIME NOT NULL,
    `end_time` TIME NOT NULL,
    `is_booked` BOOLEAN NOT NULL DEFAULT FALSE,
    `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (`doctor_id`) REFERENCES `doctors` (`id`) ON DELETE CASCADE,
    UNIQUE KEY `uq_doctor_slot` (`doctor_id`, `slot_date`, `start_time`),
    INDEX `idx_slots_lookup` (`doctor_id`, `slot_date`, `is_booked`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Appointments Table
CREATE TABLE `appointments` (
    `id` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    `uuid` BINARY(16) NOT NULL UNIQUE,
    `patient_id` BIGINT UNSIGNED NOT NULL,
    `doctor_id` BIGINT UNSIGNED NOT NULL,
    `slot_id` BIGINT UNSIGNED NOT NULL UNIQUE,
    `appointment_date` DATE NOT NULL,
    `start_time` TIME NOT NULL,
    `end_time` TIME NOT NULL,
    `consultation_type` ENUM('video', 'voice', 'chat') NOT NULL DEFAULT 'video',
    `status` ENUM('pending', 'confirmed', 'cancelled', 'completed') NOT NULL DEFAULT 'pending',
    `notes` TEXT NULL,
    `meeting_link` VARCHAR(512) NULL,
    `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (`patient_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
    FOREIGN KEY (`doctor_id`) REFERENCES `doctors` (`id`) ON DELETE CASCADE,
    FOREIGN KEY (`slot_id`) REFERENCES `consultation_slots` (`id`) ON DELETE RESTRICT,
    INDEX `idx_appointments_uuid` (`uuid`),
    INDEX `idx_appointments_patient` (`patient_id`, `status`),
    INDEX `idx_appointments_doctor` (`doctor_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Reviews Table
CREATE TABLE `reviews` (
    `id` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    `uuid` BINARY(16) NOT NULL UNIQUE,
    `appointment_id` BIGINT UNSIGNED NOT NULL UNIQUE,
    `patient_id` BIGINT UNSIGNED NOT NULL,
    `doctor_id` BIGINT UNSIGNED NOT NULL,
    `rating` TINYINT UNSIGNED NOT NULL CHECK (`rating` BETWEEN 1 AND 5),
    `comment` TEXT NOT NULL,
    `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (`appointment_id`) REFERENCES `appointments` (`id`) ON DELETE CASCADE,
    FOREIGN KEY (`patient_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
    FOREIGN KEY (`doctor_id`) REFERENCES `doctors` (`id`) ON DELETE CASCADE,
    INDEX `idx_reviews_doctor` (`doctor_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. Refresh Tokens Table
CREATE TABLE `refresh_tokens` (
    `id` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    `token_hash` VARCHAR(255) NOT NULL UNIQUE,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `expires_at` TIMESTAMP NOT NULL,
    `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
    INDEX `idx_tokens_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. Mood Entries Table
CREATE TABLE `mood_entries` (
    `id` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    `uuid` BINARY(16) NOT NULL UNIQUE,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `mood_score` TINYINT UNSIGNED NOT NULL CHECK (`mood_score` BETWEEN 1 AND 5),
    `notes` TEXT NULL,
    `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
    INDEX `idx_moods_user_date` (`user_id`, `created_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 8. Pre-Session Data Table
CREATE TABLE `pre_session_data` (
    `id` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    `appointment_id` BIGINT UNSIGNED NOT NULL UNIQUE,
    `questions_json` JSON NOT NULL, -- Array of 5 questions generated by Gemini
    `answers_json` JSON NULL,       -- Array of key-value answers from patient
    `briefing_text` TEXT NULL,      -- Compiled briefing summary for Doctor
    `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (`appointment_id`) REFERENCES `appointments` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 9. Notifications Table
CREATE TABLE `notifications` (
    `id` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    `uuid` BINARY(16) NOT NULL UNIQUE,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `message` TEXT NOT NULL,
    `is_read` BOOLEAN NOT NULL DEFAULT FALSE,
    `type` VARCHAR(50) NOT NULL DEFAULT 'system',
    `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
    INDEX `idx_notifications_unread` (`user_id`, `is_read`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
```

---

## 2. Directory Layouts

### 2.1. Golang Backend Project Layout
The Go backend is structured using a clean, layered architecture conforming to the Standard Go Project Layout.

```
server/
├── cmd/
│   └── api/
│       └── main.go              # Entry point, DB connection, & dependency injection
├── internal/
│   ├── config/                  # App configurations & env parser
│   ├── middleware/              # Auth, RateLimit, CORS, Recovery
│   ├── model/                   # Domain entities and raw DB mapping
│   ├── repository/              # MySQL data-access (1 file per entity, SRP)
│   │   ├── appointment_repo.go
│   │   ├── doctor_repo.go
│   │   ├── auth_repo.go
│   │   └── mood_repo.go
│   ├── service/                 # Domain logic & transactions (SRP)
│   │   ├── appointment_service.go
│   │   ├── auth_service.go
│   │   └── ai_service.go
│   └── handler/                 # Controllers parsing HTTP (SRP)
│       ├── appointment_handler.go
│       ├── auth_handler.go
│       ├── doctor_handler.go
│       └── mood_handler.go
├── pkg/
│   ├── crypto/                  # Argon2id wrapper
│   ├── token/                   # JWT creation & verification
│   └── uuidutil/                # Binary-UUID encoders/decoders
├── go.mod
└── go.sum
```

### 2.2. Next.js Frontend Layout (App Router)
All presentational code is separated from state and side-effects.

```
client/
├── app/                         # App router pages
│   ├── (auth)/                  # Auth group layout
│   │   ├── login/page.tsx
│   │   └── register/page.tsx
│   ├── dashboard/               # Combined dashboard router
│   │   ├── layout.tsx           # Protected route wrapper & Sidebar
│   │   ├── page.tsx
│   │   ├── admin/               # Admin controller view
│   │   └── appointments/        # Patient/Doctor history list
│   └── layout.tsx               # Root layout
├── components/                  # Presentational UI components
│   ├── appointments/            # Dialog cards, date pickers
│   ├── profile/                 # Avatar uploads, settings forms
│   └── ui/                      # Base buttons, toast alerts
├── hooks/                       # Extracted state & data fetching hooks
│   ├── useAppointments.ts       # Booking & updating actions
│   ├── useAuth.ts               # Login, signout, session state
│   ├── useDoctors.ts            # Fetching & filtering catalog
│   ├── useMood.ts               # Mood analytics logs hook
│   └── useNotifications.ts      # Inbox and unread badges
├── lib/
│   ├── api.ts                   # Axios core client with interceptors
│   ├── utils.ts                 # Class merger utility
│   ├── validations/             # Zod schemas for forms
│   │   └── auth.schema.ts
│   └── types/                   # Unified TS declarations folder
│       └── index.types.ts       # Domain structures (User, Slot, etc.)
└── tsconfig.json
```

---

## 3. Golang Backend Implementation Blueprint

### 3.1. Layered Code Example: Appointment Booking (Under 80-100 Lines per File)

#### Layer A: Model / DTO Definition (`internal/model/appointment.go`)
```go
package model

import "time"

type ConsultationType string
const (
	TypeVideo ConsultationType = "video"
	TypeVoice ConsultationType = "voice"
	TypeChat  ConsultationType = "chat"
)

type AppointmentStatus string
const (
	StatusPending   AppointmentStatus = "pending"
	StatusConfirmed AppointmentStatus = "confirmed"
	StatusCancelled AppointmentStatus = "cancelled"
	StatusCompleted AppointmentStatus = "completed"
)

type BookAppointmentRequest struct {
	DoctorUUID       string           `json:"doctor_uuid" validate:"required,uuid4"`
	SlotUUID         string           `json:"slot_uuid" validate:"required,uuid4"`
	ConsultationType ConsultationType `json:"consultation_type" validate:"required,oneof=video voice chat"`
	Notes            string           `json:"notes" validate:"max=500"`
}

type AppointmentResponse struct {
	UUID             string            `json:"uuid"`
	DoctorName       string            `json:"doctor_name"`
	AppointmentDate  string            `json:"appointment_date"`
	StartTime        string            `json:"start_time"`
	EndTime          string            `json:"end_time"`
	ConsultationType ConsultationType  `json:"consultation_type"`
	Status           AppointmentStatus `json:"status"`
	Notes            string            `json:"notes,omitempty"`
}
```

#### Layer B: Handler / Controller (`internal/handler/appointment_handler.go`)
```go
package handler

import (
	"net/http"
	"server/internal/model"
	"server/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/go-playground/validator/v10"
)

type AppointmentHandler struct {
	Service  *service.AppointmentService
	Validate *validator.Validate
}

func (h *AppointmentHandler) Book(c *gin.Context) {
	var req model.BookAppointmentRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"status": "error", "message": "Invalid request body"})
		return
	}
	if err := h.Validate.Struct(req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"status": "error", "message": err.Error()})
		return
	}

	patientID := c.GetUint64("userId") // Injected by authenticate middleware
	result, err := h.Service.CreateBooking(c.Request.Context(), patientID, req)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"status": "error", "message": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"status": "success", "data": result})
}
```

#### Layer C: Service (`internal/service/appointment_service.go`)
```go
package service

import (
	"context"
	"database/sql"
	"errors"
	"server/internal/model"
	"server/internal/repository"
)

type AppointmentService struct {
	DB        *sql.DB
	Repo      *repository.AppointmentRepository
	NotifRepo *repository.NotificationRepository
}

func (s *AppointmentService) CreateBooking(ctx context.Context, patientID uint64, req model.BookAppointmentRequest) (*model.AppointmentResponse, error) {
	// Execute within transaction block to ensure data consistency
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	// 1. Resolve and lock Slot details
	slot, err := s.Repo.GetAndLockSlotByUUID(ctx, tx, req.SlotUUID)
	if err != nil {
		return nil, errors.New("slot not available")
	}
	if slot.IsBooked {
		return nil, errors.New("slot already booked")
	}

	// 2. Resolve Doctor details
	doctor, err := s.Repo.GetDoctorByUUID(ctx, tx, req.DoctorUUID)
	if err != nil {
		return nil, errors.New("doctor profile not found")
	}

	// 3. Insert appointment & mark slot as booked
	appUUID, err := s.Repo.InsertAppointment(ctx, tx, patientID, doctor.ID, slot.ID, req)
	if err != nil {
		return nil, err
	}
	if err = s.Repo.MarkSlotBooked(ctx, tx, slot.ID, true); err != nil {
		return nil, err
	}

	if err = tx.Commit(); err != nil {
		return nil, err
	}

	// 4. Trigger asynchronous notification to doctor
	go s.NotifRepo.CreateNotification(context.Background(), doctor.UserID, "New Booking", "A patient booked a session.")

	return &model.AppointmentResponse{
		UUID:             appUUID,
		DoctorName:       doctor.Name,
		AppointmentDate:  slot.Date,
		StartTime:        slot.StartTime,
		EndTime:          slot.EndTime,
		ConsultationType: req.ConsultationType,
		Status:           model.StatusPending,
		Notes:            req.Notes,
	}, nil
}
```

#### Layer D: Repository (`internal/repository/appointment_repo.go`)
```go
package repository

import (
	"context"
	"database/sql"
	"server/internal/model"
	"server/pkg/uuidutil"
)

type AppointmentRepository struct{}

func (r *AppointmentRepository) InsertAppointment(ctx context.Context, tx *sql.Tx, patientID, doctorID, slotID uint64, req model.BookAppointmentRequest) (string, error) {
	uuidBytes, err := uuidutil.NewV7()
	if err != nil {
		return "", err
	}

	query := `INSERT INTO appointments (uuid, patient_id, doctor_id, slot_id, consultation_type, status, notes) 
	          VALUES (?, ?, ?, ?, ?, ?, ?)`
	_, err = tx.ExecContext(ctx, query, uuidBytes, patientID, doctorID, slotID, req.ConsultationType, model.StatusPending, req.Notes)
	if err != nil {
		return "", err
	}

	return uuidutil.EncodeToString(uuidBytes), nil
}

func (r *AppointmentRepository) GetAndLockSlotByUUID(ctx context.Context, tx *sql.Tx, uuidStr string) (*model.Slot, error) {
	uuidBytes, err := uuidutil.DecodeString(uuidStr)
	if err != nil {
		return nil, err
	}

	var slot model.Slot
	query := `SELECT id, is_booked, slot_date, start_time, end_time FROM consultation_slots WHERE uuid = ? FOR UPDATE`
	err = tx.QueryRowContext(ctx, query, uuidBytes).Scan(&slot.ID, &slot.IsBooked, &slot.Date, &slot.StartTime, &slot.EndTime)
	if err != nil {
		return nil, err
	}
	return &slot, nil
}
```

---

### 3.2. Strict Authorization (IDOR Prevention Check)

To prevent unauthorized status updates, the backend verifies that the executor's identity matches the permissions required for the state update:

```go
// In internal/service/appointment_service.go
func (s *AppointmentService) UpdateStatus(ctx context.Context, userRole string, userId uint64, appUUID string, newStatus model.AppointmentStatus) error {
	app, err := s.Repo.GetAppointmentByUUID(ctx, appUUID)
	if err != nil {
		return errors.New("appointment not found")
	}

	// IDOR Check: Ensure the user belongs to this session
	if userRole == "doctor" {
		if app.DoctorUserID != userId {
			return errors.New("access denied: unauthorized doctor") // Return 403 Forbidden
		}
	} else if userRole == "patient" {
		if app.PatientUserID != userId {
			return errors.New("access denied: unauthorized patient") // Return 403 Forbidden
		}
		// Patients are restricted to cancelling sessions
		if newStatus != model.StatusCancelled {
			return errors.New("patients can only cancel appointments")
		}
	} else if userRole != "admin" {
		return errors.New("unauthorized role")
	}

	return s.Repo.UpdateStatusInDB(ctx, app.ID, string(newStatus))
}
```

---

### 3.3. Security & Infrastructure Middleware

#### Rate Limiting Middleware (`internal/middleware/rate_limit.go`)
```go
package middleware

import (
	"net/http"
	"sync"
	"time"
	"github.com/gin-gonic/gin"
	"golang.org/x/time/rate"
)

type IPRateLimiter struct {
	ips map[string]*rate.Limiter
	mu  sync.RWMutex
}

func NewIPRateLimiter() *IPRateLimiter {
	return &IPRateLimiter{ips: make(map[string]*rate.Limiter)}
}

func (i *IPRateLimiter) GetLimiter(ip string) *rate.Limiter {
	i.mu.Lock()
	defer i.mu.Unlock()
	limiter, exists := i.ips[ip]
	if !exists {
		// Limit to 2 requests/sec burst to 5
		limiter = rate.NewLimiter(rate.Every(500*time.Millisecond), 5)
		i.ips[ip] = limiter
	}
	return limiter
}

func RateLimiterMiddleware(limiter *IPRateLimiter) gin.HandlerFunc {
	return func(c *gin.Context) {
		ip := c.ClientIP()
		if !limiter.GetLimiter(ip).Allow() {
			c.JSON(http.StatusTooManyRequests, gin.H{"status": "error", "message": "Too many requests"})
			c.Abort()
			return
		}
		c.Next()
	}
}
```

#### JWT Middleware (`internal/middleware/auth.go`)
```go
package middleware

import (
	"net/http"
	"strings"
	"server/pkg/token"
	"github.com/gin-gonic/gin"
)

func AuthMiddleware(tokenMaker token.Maker) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Expects a cookie named "access_token" or Bearer token fallback
		accessToken, err := c.Cookie("access_token")
		if err != nil {
			authHeader := c.GetHeader("Authorization")
			if len(authHeader) == 0 {
				c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "authorization header or cookie not provided"})
				return
			}
			fields := strings.Fields(authHeader)
			if len(fields) < 2 || strings.ToLower(fields[0]) != "bearer" {
				c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid authorization format"})
				return
			}
			accessToken = fields[1]
		}

		payload, err := tokenMaker.VerifyToken(accessToken)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid or expired token"})
			return
		}

		c.Set("userId", payload.UserID)
		c.Set("userRole", payload.Role)
		c.Next()
	}
}
```

#### Argon2id Password Hashing (`pkg/crypto/password.go`)
```go
package crypto

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"golang.org/x/crypto/argon2"
)

type Params struct {
	Memory      uint32
	Iterations  uint32
	Parallelism uint8
	SaltLength  uint32
	KeyLength   uint32
}

var DefaultParams = Params{
	Memory:      64 * 1024, // 64 MB
	Iterations:  3,
	Parallelism: 2,
	SaltLength:  16,
	KeyLength:   32,
}

func HashPassword(password string) (string, error) {
	salt := make([]byte, DefaultParams.SaltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}

	hash := argon2.IDKey([]byte(password), salt, DefaultParams.Iterations, DefaultParams.Memory, DefaultParams.Parallelism, DefaultParams.KeyLength)
	
	b64Salt := base64.RawStdEncoding.EncodeToString(salt)
	b64Hash := base64.RawStdEncoding.EncodeToString(hash)
	
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s", DefaultParams.Memory, DefaultParams.Iterations, DefaultParams.Parallelism, b64Salt, b64Hash), nil
}
```

---

### 3.4. AI Consultation Service (Go Gemini API)

This service loads `gemini-2.0-flash` utilizing the official Go SDK:

```go
package service

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"github.com/google/generative-ai-go/genai"
	"google.golang.org/api/option"
)

type AIService struct {
	client *genai.Client
}

func NewAIService() (*AIService, error) {
	ctx := context.Background()
	client, err := genai.NewClient(ctx, option.WithAPIKey(os.Getenv("GEMINI_API_KEY")))
	if err != nil {
		return nil, err
	}
	return &AIService{client: client}, nil
}

func (s *AIService) SuggestWellnessResources(ctx context.Context, moods []int, notes []string) ([]string, error) {
	model := s.client.GenerativeModel("gemini-2.0-flash")
	
	prompt := fmt.Sprintf("Analyze: Mood ratings=%v, User Notes=%s. Suggest 3 personalized wellness exercises as a JSON array of strings.", moods, strings.Join(notes, "; "))
	resp, err := model.GenerateContent(ctx, genai.Text(prompt))
	if err != nil {
		return nil, err
	}

	var suggestions []string
	partText := fmt.Sprintf("%v", resp.Candidates[0].Content.Parts[0])
	// Strip markdown blocks if present (regex not shown for brevity, replace ```json ...)
	err = json.Unmarshal([]byte(partText), &suggestions)
	if err != nil {
		return []string{"Deep breathing exercises", "Daily walk", "Gratitude journaling"}, nil
	}

	return suggestions, nil
}
```

---

## 4. Next.js Frontend Implementation Blueprint

### 4.1. Core Types Configuration (`lib/types/index.types.ts`)
```typescript
export type UserRole = "patient" | "doctor" | "admin";

export interface User {
    uuid: string;
    email: string;
    name: string;
    avatarUrl?: string;
    role: UserRole;
    phoneNumber?: string;
}

export interface Doctor {
    uuid: string;
    name: string;
    specialty: string;
    avatarUrl: string;
    rating: number;
    price: number;
    experience: number;
    bio: string;
}

export interface Appointment {
    uuid: string;
    doctorName?: string;
    patientName?: string;
    date: string;
    startTime: string;
    endTime: string;
    type: "video" | "voice" | "chat";
    status: "pending" | "confirmed" | "cancelled" | "completed";
}
```

### 4.2. Extracted Data Fetching Hooks (`hooks/useAppointments.ts`)
```typescript
import { useState, useCallback } from "react";
import api from "@/lib/api";
import { Appointment } from "@/lib/types/index.types";

export function useAppointments() {
    const [appointments, setAppointments] = useState<Appointment[]>([]);
    const [isLoading, setIsLoading] = useState(false);

    const fetchAppointments = useCallback(async () => {
        setIsLoading(true);
        try {
            const res = await api.get("/appointments/my");
            setAppointments(res.data.data);
        } catch (err) {
            console.error("Failed to load appointments:", err);
        } finally {
            setIsLoading(false);
        }
    }, []);

    const updateStatus = useCallback(async (appUuid: string, status: string) => {
        try {
            await api.put(`/appointments/${appUuid}/status`, { status });
            await fetchAppointments();
        } catch (err) {
            console.error("Failed status change:", err);
        }
    }, [fetchAppointments]);

    return { appointments, isLoading, fetchAppointments, updateStatus };
}
```

### 4.3. Zod Schema Validation (`lib/validations/auth.schema.ts`)
```typescript
import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().email({ message: "Invalid email address." }),
  password: z.string().min(8, { message: "Password must be at least 8 characters." })
});

export type LoginFormData = z.infer<typeof loginSchema>;
```

### 4.4. API Connection Client (`lib/api.ts`)
```typescript
import axios from "axios";

const api = axios.create({
    baseURL: process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api",
    withCredentials: true,
    headers: {
        "Content-Type": "application/json",
    },
});

// Refresh tokens automatically when a 401 response occurs
api.interceptors.response.use(
    (response) => response,
    async (error) => {
        const originalRequest = error.config;
        if (error.response?.status === 401 && !originalRequest._retry) {
            originalRequest._retry = true;
            try {
                await axios.post(
                    `${api.defaults.baseURL}/auth/refresh`,
                    {},
                    { withCredentials: true }
                );
                return api(originalRequest);
            } catch (refreshErr) {
                if (typeof window !== "undefined") {
                    window.location.href = "/login";
                }
                return Promise.reject(refreshErr);
            }
        }
        return Promise.reject(error);
    }
);

export default api;
```

---

## 5. API Contracts & Endpoints Reference

### 5.1. Authentication
- **POST /api/auth/register** - Register user
- **POST /api/auth/login** - Email/pass login
- **POST /api/auth/google** - Login via Google ID token
- **POST /api/auth/refresh** - Rotates access/refresh tokens
- **POST /api/auth/logout** - Invalidate session

### 5.2. Search Doctors
- **GET /api/doctors**
  - **Query Params**: `?specialty=Clinical&price=under100&sort=rating&page=1&limit=10`
  - **Response (JSON)**:
    ```json
    {
      "status": "success",
      "data": [
        {
          "uuid": "018f7a83-b8cb-7761-9c2d-45ca8126df02",
          "name": "Dr. Sarah Adams",
          "specialty": "Clinical Psychologist",
          "rating": 4.9,
          "price": 95000
        }
      ],
      "pagination": { "current_page": 1, "total_pages": 1, "total_count": 1 }
    }
    ```

### 5.3. Appointments
- **POST /api/appointments/book**
  - **Request Body**:
    ```json
    {
      "doctor_uuid": "018f7a83-b8cb-7761-9c2d-45ca8126df02",
      "slot_uuid": "018f7a83-b9dc-7872-ad3e-56da9237ef03",
      "consultation_type": "video",
      "notes": "Struggling with sleep patterns."
    }
    ```
- **PUT /api/appointments/:uuid/status** - Doctor accepts/rejects, Patient cancels
- **GET /api/appointments/my** - List authenticated user's appointments

### 5.4. Wellness & AI
- **POST /api/mood/log** - Submit daily mood (1-5)
- **GET /api/mood/stats** - Get 14-day history and streak data
- **GET /api/ai/briefing/:appointmentUuid** (Doctor only) - Retrieve AI compiled case summary

---

## 6. Environment Variables (`.env.example`)

```env
# Server
PORT=5000
GIN_MODE=debug
FRONTEND_URL=http://localhost:3000

# Database (MySQL 8)
DB_USER=mindease
DB_PASS=mindease_secure
DB_HOST=localhost
DB_PORT=3306
DB_NAME=mindease_db

# Security Secrets
JWT_ACCESS_SECRET=your_super_secret_access_key
JWT_REFRESH_SECRET=your_super_secret_refresh_key

# External Services
GEMINI_API_KEY=your_gemini_2_flash_api_key
GOOGLE_CLIENT_ID=your_google_oauth2_client_id
```

## 7. Testing Strategy
1. **Go Backend**:
   - `internal/handler`: Tested using `httptest` to mock requests and assert HTTP codes and JSON shapes.
   - `internal/service`: Unit tested utilizing interface mocking for `repository` (e.g., using `mockgen`).
2. **Next.js Frontend**:
   - Component testing with React Testing Library and Jest for forms and modal interactions.
   - E2E flows (Login -> Book -> View Appointments) validated with Cypress/Playwright.
