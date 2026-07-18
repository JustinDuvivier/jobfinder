/**
 * Assemble the human-readable job posting text passed to the AI calls (scoring,
 * rewrite, explanation) from a Job row.
 */
import type { Job } from '../types';

export function describeJob(job: Job): string {
  const lines = [`${job.title} at ${job.company}`];
  if (job.location) lines.push(`Location: ${job.location}`);
  if (job.salary) lines.push(`Salary: ${job.salary}`);
  if (job.seniorityLevel) lines.push(`Seniority level: ${job.seniorityLevel}`);
  if (job.employmentType) lines.push(`Employment type: ${job.employmentType}`);
  if (job.jobFunction) lines.push(`Job function: ${job.jobFunction}`);
  if (job.industries) lines.push(`Industries: ${job.industries}`);
  if (job.applicants) lines.push(`Applicants: ${job.applicants}`);
  if (job.description) {
    lines.push('');
    lines.push(job.description);
  }
  return lines.join('\n');
}
