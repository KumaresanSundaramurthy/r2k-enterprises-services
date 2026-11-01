import { Injectable } from "@nestjs/common";
import { BackgroundTaskService } from "../../core/background/background-task.service";
import { TranslationService, TypedText } from "../../libraries/translation/translation.service";

export interface TypedNameDescription {
  name: TypedText;
  description: TypedText;
}

/**
 * Name + description in two languages, the pair every product master has (CI3 _triggerProdLangSave,
 * _triggerCatgLangSave, _triggerBrandLangSave, _triggerSizeLangSave, _triggerPriceListLangSave): Tamil
 * input is stored in English; the Tamil *_Lang row is written after the response, in the background.
 */
@Injectable()
export class ProductTextService {
  constructor(
    private readonly translation: TranslationService,
    private readonly background: BackgroundTaskService
  ) {}

  // English for the base table (null when empty) and what was typed, for the Tamil row
  async normalize(name: string | null | undefined, description: string | null | undefined) {
    const [n, d] = await Promise.all([this.translation.normalize((name ?? "").trim()), this.translation.normalize((description ?? "").trim())]);
    return { name: n.english, description: d.english, typed: { name: n.typed, description: d.typed } as TypedNameDescription };
  }

  // Tamil name + description, saved after the response by `save`
  scheduleTamil(label: string, typed: TypedNameDescription, save: (name: string | null, description: string | null) => Promise<void>): void {
    this.background.run(`Tamil text for ${label}`, async () => {
      const [name, description] = await Promise.all([this.translation.typedToTamil(typed.name), this.translation.typedToTamil(typed.description)]);
      await save(name, description);
    });
  }
}
