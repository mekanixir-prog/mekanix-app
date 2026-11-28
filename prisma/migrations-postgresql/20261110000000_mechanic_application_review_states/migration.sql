-- Separate approval and rejection claims so concurrent reviewers cannot
-- finalize conflicting decisions for the same mechanic application.
ALTER TYPE "ApplicationStatus" ADD VALUE 'APPROVING';
ALTER TYPE "ApplicationStatus" ADD VALUE 'REJECTING';
