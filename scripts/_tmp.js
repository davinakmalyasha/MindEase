const fs = require("fs");

const FILES = [
  "client/app/dashboard/briefing/[appointmentId]/page.tsx",
  "client/app/dashboard/pre-session/[appointmentId]/page.tsx",
  "client/app/dashboard/profile/page.tsx",
  "client/app/doctors/[id]/page.tsx",
  "client/components/doctors/DoctorProfile.tsx",
  "client/hooks/useNotifications.ts",
];

for (const f of FILES) {
  const lines = fs.readFileSync(f, "utf8").split("\n");
  console.log(`\n########## ${f} (${lines.length} lines)`);
  lines.forEach((l, i) => {
    if (/\.catch\(|setError|useState<[^>]*null>|if \(!.*\)|=== null|&\(/.test(l)) {
      const t = l.trim();
      if (t.length > 150) return;
      console.log(`${String(i + 1).padStart(4)}: ${t}`);
    }
  });
}