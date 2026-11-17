import { Injectable } from "@nestjs/common";
import { CiValidationError } from "../../core/response/ci-response";
import { TodosRepository } from "./todos.repository";

type Row = Record<string, unknown>;

@Injectable()
export class TodosService {
  constructor(private readonly repo: TodosRepository) {}

  async getDetail(orgUID: number, todoUID: number): Promise<{ Todo: Row }> {
    if (todoUID <= 0) throw new CiValidationError("Invalid task.");
    const todo = await this.repo.getById(orgUID, todoUID);
    if (!todo) throw new CiValidationError("Task not found.");
    return { Todo: todo };
  }

  async getBadgeCount(orgUID: number, userUID: number): Promise<{ Count: number }> {
    return { Count: await this.repo.getPendingBadgeCount(orgUID, userUID) };
  }

  async getLinkedTodos(orgUID: number, refType: string, refUID: number): Promise<{ rows: Row[] }> {
    if (!refType || refUID <= 0) throw new CiValidationError("Invalid reference.");
    return { rows: await this.repo.getLinkedTodos(orgUID, refType, refUID) };
  }
}
