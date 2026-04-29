import type { Member, Task, TeamState } from "../domain/types.js";
import type { DiscussionThreadState } from "./discussionState.js";
import { discussionThreads } from "./discussionState.js";

export const TASK_REVIEW_SUBJECT_PREFIX = "Task review:";

export type TaskReviewState =
  | "not_applicable"
  | "review_recommended"
  | "review_open"
  | "review_settled"
  | "follow_up_created";

export interface TaskReviewSummary {
  reviewState: TaskReviewState;
  reviewThreadId?: string;
  reviewerMemberIds: string[];
  reviewerMemberNames: string[];
  reviewActionSummary?: string;
  followUpTaskId?: string;
}

interface ReviewerCandidate {
  member: Member;
  score: number;
}

const REVIEWER_KEYWORDS = [
  "review",
  "reviewer",
  "test",
  "tester",
  "qa",
  "quality",
  "verify",
  "verification",
  "validate",
  "validation",
  "risk",
  "safety"
];

export function reviewSubjectForTask(task: Pick<Task, "id">): string {
  return `${TASK_REVIEW_SUBJECT_PREFIX} ${task.id}`;
}

export function reviewDiscussionThreadForTask(
  state: TeamState,
  task: Pick<Task, "id" | "teamId">
): DiscussionThreadState | undefined {
  const expectedSubject = reviewSubjectForTask(task);
  return discussionThreads(state, task.teamId)
    .find((thread) => thread.subject?.startsWith(expectedSubject) && thread.messages.some((message) => message.taskId === task.id));
}

export function taskReviewSummary(state: TeamState, task: Task): TaskReviewSummary {
  const thread = reviewDiscussionThreadForTask(state, task);
  if (thread) {
    const reviewerMemberIds = thread.expectedMemberIds.length > 0
      ? thread.expectedMemberIds
      : selectReviewerMembers(state, task).map((member) => member.id);
    const reviewerMemberNames = reviewerMemberIds.map((memberId) => state.members[memberId]?.name ?? memberId);
    if (thread.committedTaskId) {
      return {
        reviewState: "follow_up_created",
        reviewThreadId: thread.threadId,
        reviewerMemberIds,
        reviewerMemberNames,
        reviewActionSummary: `Review thread ${thread.threadId} created follow-up task ${thread.committedTaskId}.`,
        followUpTaskId: thread.committedTaskId
      };
    }
    if (thread.lifecycleState === "settled") {
      return {
        reviewState: "review_settled",
        reviewThreadId: thread.threadId,
        reviewerMemberIds,
        reviewerMemberNames,
        reviewActionSummary: taskReviewNeedsFollowUp(state, task)
          ? thread.suggestedActionSummary
          : `Review thread ${thread.threadId} is settled with no follow-up task recommendation.`
      };
    }
    return {
      reviewState: "review_open",
      reviewThreadId: thread.threadId,
      reviewerMemberIds,
      reviewerMemberNames,
      reviewActionSummary: thread.nextTurnSummary ?? thread.suggestedActionSummary
    };
  }

  if (task.status !== "completed") {
    return emptyTaskReview("not_applicable");
  }

  const reviewers = selectReviewerMembers(state, task);
  if (reviewers.length === 0) {
    return emptyTaskReview("not_applicable");
  }

  return {
    reviewState: "review_recommended",
    reviewerMemberIds: reviewers.map((member) => member.id),
    reviewerMemberNames: reviewers.map((member) => member.name),
    reviewActionSummary: `Ask ${formatMemberList(reviewers.map((member) => member.name))} to review completed task ${task.id}.`
  };
}

export function reviewDiscussionBody(task: Task, review: TaskReviewSummary): string {
  const reviewers = review.reviewerMemberNames.length > 0
    ? formatMemberList(review.reviewerMemberNames)
    : "the reviewer";
  return [
    `Please review completed task ${task.id}: ${task.title}`,
    task.completionSummary ? `Completion summary: ${task.completionSummary}` : undefined,
    task.resultArtifacts?.length ? `Artifacts: ${task.resultArtifacts.join(", ")}` : undefined,
    task.pathHints.length > 0 ? `Task paths: ${task.pathHints.join(", ")}` : undefined,
    `Expected from ${reviewers}: send one mailbox opinion with accept, concern, question, or follow-up recommendation.`
  ].filter(Boolean).join("\n");
}

export function taskReviewNeedsFollowUp(state: TeamState, task: Pick<Task, "id" | "teamId">): boolean {
  const thread = reviewDiscussionThreadForTask(state, task);
  if (!thread) {
    return false;
  }
  if (thread.committedTaskId || thread.actionabilityState === "ready_for_task") {
    return true;
  }
  return thread.messages
    .filter((message) => message.fromMemberId)
    .some((message) => {
      if (message.type === "handoff" || message.type === "result") {
        return true;
      }
      const text = `${message.subject ?? ""}\n${message.body}`.toLowerCase();
      return /\bfollow[- ]?up\b/.test(text)
        || /\bconcern\b/.test(text)
        || /\bquestion\b/.test(text);
    });
}

function emptyTaskReview(reviewState: TaskReviewState): TaskReviewSummary {
  return {
    reviewState,
    reviewerMemberIds: [],
    reviewerMemberNames: []
  };
}

function selectReviewerMembers(state: TeamState, task: Task): Member[] {
  return Object.values(state.members)
    .filter((member) => member.teamId === task.teamId && member.status === "active")
    .filter((member) => member.id !== task.assignedMemberId)
    .map((member): ReviewerCandidate => ({
      member,
      score: reviewerScore(member, task)
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((first, second) => {
      if (first.score !== second.score) {
        return second.score - first.score;
      }
      const firstOrder = first.member.createdOrder ?? Number.MAX_SAFE_INTEGER;
      const secondOrder = second.member.createdOrder ?? Number.MAX_SAFE_INTEGER;
      if (firstOrder !== secondOrder) {
        return firstOrder - secondOrder;
      }
      return first.member.createdAt.localeCompare(second.member.createdAt);
    })
    .slice(0, 2)
    .map((candidate) => candidate.member);
}

function reviewerScore(member: Member, task: Task): number {
  const roleHaystack = [
    member.name,
    member.rawResponsibility,
    member.polishedPrompt,
    ...(member.capabilities ?? []),
    ...(member.callWhen ?? [])
  ].filter(Boolean).join(" ").toLowerCase();
  const taskHaystack = [
    task.title,
    task.description,
    task.completionSummary,
    ...(task.resultArtifacts ?? []),
    ...task.pathHints
  ].filter(Boolean).join(" ").toLowerCase();

  const keywordScore = REVIEWER_KEYWORDS.reduce((score, keyword) => (
    roleHaystack.includes(keyword) ? score + 10 : score
  ), 0);
  const callWhenScore = (member.callWhen ?? []).some((entry) => textMatches(entry, taskHaystack)) ? 20 : 0;
  return keywordScore + callWhenScore;
}

function textMatches(needle: string, haystack: string): boolean {
  const normalized = needle.toLowerCase().trim();
  if (!normalized || !haystack.trim()) {
    return false;
  }
  if (haystack.includes(normalized)) {
    return true;
  }
  const tokens = normalized.split(/[^a-z0-9]+/).filter((token) => token.length > 2);
  return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
}

function formatMemberList(memberNames: string[]): string {
  if (memberNames.length === 0) {
    return "the reviewer";
  }
  if (memberNames.length === 1) {
    return memberNames[0]!;
  }
  if (memberNames.length === 2) {
    return `${memberNames[0]} and ${memberNames[1]}`;
  }
  return `${memberNames.slice(0, -1).join(", ")}, and ${memberNames.at(-1)}`;
}
