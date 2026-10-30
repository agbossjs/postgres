import { Text } from "@agboss/core/dto";

/** A job: what a workflow (or a child) is started with. */
export class JobDto {
  @Text({ prompt: "the job's name" })
  name!: string;
}

/** A job done, and the instance that did its last step. */
export class DoneDto {
  @Text({ prompt: "the job's name" })
  name!: string;

  @Text({ prompt: "the instance that did it" })
  by!: string;
}

/** What a batch of jobs came to. */
export class SummaryDto {
  @Text({ prompt: "the jobs done, by whom" })
  text!: string;
}
