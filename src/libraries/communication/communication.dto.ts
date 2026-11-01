import { ApiPropertyOptional } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { OrgUserContextDto } from "../../core/dto/write-context.dto";

// sendCommunication form (CI3 communication.js); values are checked by CommunicationService so the messages match CI3.
export class CommunicationDto extends OrgUserContextDto {
  @ApiPropertyOptional({ enum: ["SMS", "Email"] }) @Allow() CommType?: string;
  @ApiPropertyOptional({ type: [Number], description: "Recipient UIDs (UIDs[] in multipart)" }) @Allow() UIDs?: (string | number)[] | string | number;
  @ApiPropertyOptional({ description: "SMS text, or the email's HTML body" }) @Allow() Message?: string;
  @ApiPropertyOptional({ description: "Required for Email" }) @Allow() Subject?: string;
  @ApiPropertyOptional({ description: "Sent by the CI3 form; not used (as in CI3)" }) @Allow() RecipientType?: string;
  @ApiPropertyOptional({ description: "Sent by the CI3 form; not used (as in CI3)" }) @Allow() ModuleUID?: string | number;
  @ApiPropertyOptional({ description: "Sent by the CI3 form; not used (as in CI3)" }) @Allow() RecordUID?: string | number;
}
