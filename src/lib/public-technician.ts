import { maskFinancialFields } from "@/lib/money/financial-read-mask";

export const PUBLIC_TECHNICIAN_SELECT = {
  id: true,
  bio: true,
  experienceYears: true,
  completedJobs: true,
  rating: true,
  reviewCount: true,
  hourlyRate: true,
  travelFeeBase: true,
  inspectionFee: true,
  inspectionFeeHeavy: true,
  financialUnitStatus: true,
  status: true,
  verified: true,
  level: true,
  availableNow: true,
  responseMins: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { name: true, avatar: true } },
  specialties: { select: { id: true, category: true, label: true } },
  certifications: { select: { id: true, name: true, issuer: true, year: true, verified: true } },
  serviceAreas: { select: { id: true, name: true, radiusKm: true } },
} as const;

export const PUBLIC_TECHNICIAN_LIST_SELECT = PUBLIC_TECHNICIAN_SELECT;

export const PUBLIC_TECHNICIAN_DETAIL_SELECT = {
  ...PUBLIC_TECHNICIAN_SELECT,
  reviews: {
    select: {
      id: true,
      rating: true,
      comment: true,
      tags: true,
      createdAt: true,
      fromUser: { select: { name: true, avatar: true } },
    },
    orderBy: { createdAt: "desc" as const },
    take: 20,
  },
} as const;

const FINANCIAL_FIELDS = ["hourlyRate", "travelFeeBase", "inspectionFee", "inspectionFeeHeavy"];

/**
 * Explicit public projection. Never return Technician/User/Vehicle/Job ORM
 * objects directly: those models contain private coordinates, user IDs,
 * customer vehicles, and other internal fields.
 */
export function toPublicTechnician(technician: any, distanceKm?: number) {
  const masked = maskFinancialFields(technician, FINANCIAL_FIELDS);
  return {
    id: masked.id,
    bio: masked.bio,
    experienceYears: masked.experienceYears,
    completedJobs: masked.completedJobs,
    rating: masked.rating,
    reviewCount: masked.reviewCount,
    hourlyRate: masked.hourlyRate,
    travelFeeBase: masked.travelFeeBase,
    inspectionFee: masked.inspectionFee,
    inspectionFeeHeavy: masked.inspectionFeeHeavy,
    status: masked.status,
    verified: masked.verified,
    level: masked.level,
    availableNow: masked.availableNow,
    responseMins: masked.responseMins,
    createdAt: masked.createdAt,
    updatedAt: masked.updatedAt,
    user: masked.user ? { name: masked.user.name, avatar: masked.user.avatar } : null,
    specialties: (masked.specialties ?? []).map((item: any) => ({
      id: item.id, category: item.category, label: item.label,
    })),
    certifications: (masked.certifications ?? []).map((item: any) => ({
      id: item.id, name: item.name, issuer: item.issuer, year: item.year, verified: item.verified,
    })),
    serviceAreas: (masked.serviceAreas ?? []).map((area: any) => ({
      id: area.id, name: area.name, radiusKm: area.radiusKm,
    })),
    reviews: (masked.reviews ?? []).map((review: any) => ({
      id: review.id,
      rating: review.rating,
      comment: review.comment,
      tags: review.tags,
      createdAt: review.createdAt,
      fromUser: review.fromUser ? { name: review.fromUser.name, avatar: review.fromUser.avatar } : null,
    })),
    ...(distanceKm !== undefined && Number.isFinite(distanceKm)
      ? { distanceKm: Math.round(distanceKm * 10) / 10 }
      : {}),
  };
}
