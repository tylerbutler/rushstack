// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as path from 'path';
import { PackageName, FileSystem, NewlineKind } from '@rushstack/node-core-library';
import {
  DocSection,
  DocPlainText,
  DocLinkTag,
  TSDocConfiguration,
  StringBuilder,
  DocNodeKind,
  DocParagraph,
  DocCodeSpan,
  DocFencedCode,
  StandardTags,
  DocBlock,
  DocComment,
  DocNodeContainer,
  DocHtmlStartTag,
  DocHtmlEndTag,
  DocHtmlAttribute
} from '@microsoft/tsdoc';
import {
  ApiModel,
  ApiItem,
  ApiEnum,
  ApiPackage,
  ApiItemKind,
  ApiReleaseTagMixin,
  ApiDocumentedItem,
  ApiClass,
  ReleaseTag,
  ApiStaticMixin,
  ApiPropertyItem,
  ApiInterface,
  Excerpt,
  ApiParameterListMixin,
  ApiReturnTypeMixin,
  ApiDeclaredItem,
  ApiNamespace,
  ExcerptTokenKind,
  IResolveDeclarationReferenceResult,
  ApiTypeAlias,
  ExcerptToken,
  ApiOptionalMixin
} from '@microsoft/api-extractor-model';

import { CustomDocNodes } from '../nodes/CustomDocNodeKind';
import { DocHeading } from '../nodes/DocHeading';
import { DocTable } from '../nodes/DocTable';
import { DocEmphasisSpan } from '../nodes/DocEmphasisSpan';
import { DocTableRow } from '../nodes/DocTableRow';
import { DocTableCell } from '../nodes/DocTableCell';
import { DocNoteBox } from '../nodes/DocNoteBox';
import { Utilities } from '../utils/Utilities';
import { CondensedMarkdownEmitter } from '../markdown/CondensedMarkdownEmitter';
import { PluginLoader } from '../plugin/PluginLoader';
import {
  IMarkdownDocumenterFeatureOnBeforeWritePageArgs,
  MarkdownDocumenterFeatureContext
} from '../plugin/MarkdownDocumenterFeature';
import { DocumenterConfig } from './DocumenterConfig';
import { MarkdownDocumenterAccessor } from '../plugin/MarkdownDocumenterAccessor';
import { FrontMatter } from './FrontMatter';
import { IMarkdownDocumenterOptions, MarkdownDocumenter } from './MarkdownDocumenter';

/**
 * Renders API documentation in the Markdown file format.
 * For more info:  https://en.wikipedia.org/wiki/Markdown
 */
export class CondensedMarkdownDocumenter extends MarkdownDocumenter {
  private _currentApiItemPage: ApiItem | undefined;
  private _frontMatter: FrontMatter;

  private readonly _uriRoot: string;

  public constructor(options: IMarkdownDocumenterOptions) {
    super(options);
    this._tsdocConfiguration = CustomDocNodes.configuration;
    this._frontMatter = new FrontMatter();
    this._markdownEmitter = new CondensedMarkdownEmitter(this._apiModel);

    this._uriRoot = '/';
    if (this._documenterConfig && this._documenterConfig.uriRoot !== undefined) {
      this._uriRoot = this._documenterConfig.uriRoot! + '/';
    }
  }

  protected _writeApiItemPage(apiItem: ApiItem, output?: DocSection | DocParagraph): void {
    const configuration: TSDocConfiguration = this._tsdocConfiguration;
    if (!output) {
      output = new DocSection({ configuration: this._tsdocConfiguration });
    }

    if (output instanceof DocSection) {
      this._writeBreadcrumb(output, apiItem);
    }
    if (this._shouldHaveStandalonePage(apiItem)) {
      this._frontMatter = new FrontMatter();
      this._currentApiItemPage = apiItem;
    }

    const scopedName: string = apiItem.getScopedNameWithinPackage();

    this.writeHeadings(apiItem, output, configuration, scopedName);

    if (ApiReleaseTagMixin.isBaseClassOf(apiItem)) {
      if (apiItem.releaseTag === ReleaseTag.Beta) {
        this._writeBetaWarning(output);
      }
    }

    const decoratorBlocks: DocBlock[] = [];

    if (apiItem instanceof ApiDocumentedItem) {
      const tsdocComment: DocComment | undefined = apiItem.tsdocComment;

      if (tsdocComment) {
        decoratorBlocks.push(
          ...tsdocComment.customBlocks.filter(
            (block) => block.blockTag.tagNameWithUpperCase === StandardTags.decorator.tagNameWithUpperCase
          )
        );

        if (tsdocComment.deprecatedBlock) {
          output.appendNode(
            new DocNoteBox({ configuration: this._tsdocConfiguration }, [
              new DocParagraph({ configuration: this._tsdocConfiguration }, [
                new DocPlainText({
                  configuration: this._tsdocConfiguration,
                  text: 'Warning: This API is now obsolete. '
                })
              ]),
              ...tsdocComment.deprecatedBlock.content.nodes
            ])
          );
        }

        this._appendSection(output, tsdocComment.summarySection);
      }
    }

    if (apiItem instanceof ApiDeclaredItem) {
      if (apiItem.excerpt.text.length > 0) {
        output.appendNode(
          new DocParagraph({ configuration }, [
            new DocEmphasisSpan({ configuration, bold: true }, [
              new DocPlainText({ configuration, text: 'Signature:' })
            ])
          ])
        );
        output.appendNode(
          new DocFencedCode({
            configuration,
            code: apiItem.getExcerptWithModifiers(),
            language: 'typescript'
          })
        );
      }

      this._writeHeritageTypes(output, apiItem);
    }

    if (decoratorBlocks.length > 0) {
      output.appendNode(
        new DocParagraph({ configuration }, [
          new DocEmphasisSpan({ configuration, bold: true }, [
            new DocPlainText({ configuration, text: 'Decorators:' })
          ])
        ])
      );
      for (const decoratorBlock of decoratorBlocks) {
        output.appendNodes(decoratorBlock.content.nodes);
      }
    }

    let appendRemarks: boolean = true;
    switch (apiItem.kind) {
      case ApiItemKind.Class:
      case ApiItemKind.Interface:
      case ApiItemKind.Namespace:
      case ApiItemKind.Package:
        this._writeRemarksSection(output, apiItem);
        appendRemarks = false;
        break;
    }

    switch (apiItem.kind) {
      case ApiItemKind.Class:
        this._writeClassTables(output, apiItem as ApiClass);
        break;
      case ApiItemKind.Enum:
        this._writeEnumTables(output, apiItem as ApiEnum);
        break;
      case ApiItemKind.Interface:
        this._writeInterfaceTables(output, apiItem as ApiInterface);
        break;
      case ApiItemKind.Constructor:
      case ApiItemKind.ConstructSignature:
      case ApiItemKind.Method:
      case ApiItemKind.MethodSignature:
      case ApiItemKind.Function:
        this._writeParameterTables(output, apiItem as ApiParameterListMixin);
        this._writeThrowsSection(output, apiItem);
        break;
      case ApiItemKind.Namespace:
        this._writePackageOrNamespaceTables(output, apiItem as ApiNamespace);
        break;
      case ApiItemKind.Model:
        this._writeModelTable(output, apiItem as ApiModel);
        break;
      case ApiItemKind.Package:
        this._writePackageOrNamespaceTables(output, apiItem as ApiPackage);
        break;
      case ApiItemKind.Property:
      case ApiItemKind.PropertySignature:
        break;
      case ApiItemKind.TypeAlias:
        break;
      case ApiItemKind.Variable:
        break;
      default:
        throw new Error('Unsupported API item kind: ' + apiItem.kind);
    }

    if (appendRemarks) {
      this._writeRemarksSection(output, apiItem);
    }

    // we only generate top level package pages (which will generate class and interface subpages)
    const pkg: ApiPackage | undefined = apiItem.getAssociatedPackage();
    if (!pkg || !this._isAllowedPackage(pkg)) {
      console.log(`skipping ${apiItem.getScopedNameWithinPackage()}`);
      if (pkg) {
        console.log(`\t${pkg.name} package isn't in the allowed list`);
      }
      return;
    }

    // temp hack to reduce the size of the generated content
    if (!this._shouldHaveStandalonePage(apiItem)) {
      return;
    }

    const filename: string = path.join(this._outputFolder, this._getFilenameForApiItem(apiItem));
    const stringBuilder: StringBuilder = new StringBuilder();

    stringBuilder.append(
      '<!-- Do not edit this file. It is automatically generated by API Documenter. -->\n\n'
    );

    this._writeFrontMatter(stringBuilder, apiItem);

    this._markdownEmitter.emit(stringBuilder, output, {
      contextApiItem: apiItem,
      onGetFilenameForApiItem: (apiItemForFilename: ApiItem) => {
        return this._getLinkFilenameForApiItem(apiItemForFilename);
      }
    });

    let pageContent: string = stringBuilder.toString();

    if (this._pluginLoader.markdownDocumenterFeature) {
      // Allow the plugin to customize the pageContent
      const eventArgs: IMarkdownDocumenterFeatureOnBeforeWritePageArgs = {
        apiItem: apiItem,
        outputFilename: filename,
        pageContent: pageContent
      };
      this._pluginLoader.markdownDocumenterFeature.onBeforeWritePage(eventArgs);
      pageContent = eventArgs.pageContent;
    }

    FileSystem.writeFile(filename, pageContent, {
      convertLineEndings: this._documenterConfig ? this._documenterConfig.newlineKind : NewlineKind.CrLf,
      ensureFolderExists: true
    });
    console.log(filename, 'saved to disk');
  }

  /**
   * GENERATE PAGE: MODEL
   */
  protected _writeModelTable(output: DocSection | DocParagraph, apiModel: ApiModel): void {
    const configuration: TSDocConfiguration = this._tsdocConfiguration;

    const packagesTable: DocTable = new DocTable({
      configuration,
      headerTitles: ['Package', 'Description'],
      cssClass: 'package-list',
      caption: 'List of packages in this model'
    });

    for (const apiMember of apiModel.members) {
      const row: DocTableRow = new DocTableRow({ configuration }, [
        this._createTitleCell(apiMember),
        this._createDescriptionCell(apiMember)
      ]);

      switch (apiMember.kind) {
        case ApiItemKind.Package:
          packagesTable.addRow(row);
          this._writeApiItemPage(apiMember);
          break;
      }
    }

    if (packagesTable.rows.length > 0) {
      output.appendNode(new DocHeading({ configuration: this._tsdocConfiguration, title: 'Packages' }));
      output.appendNode(packagesTable);
    }
  }

  /**
   * GENERATE PAGE: PACKAGE or NAMESPACE
   */
  protected _writePackageOrNamespaceTables(
    output: DocSection | DocParagraph,
    apiContainer: ApiPackage | ApiNamespace
  ): void {
    const configuration: TSDocConfiguration = this._tsdocConfiguration;

    const classesTable: DocTable = new DocTable({
      configuration,
      headerTitles: ['Class', 'Description'],
      cssClass: 'class-list',
      caption: 'List of classes contained in this package or namespace'
    });

    const enumerationsTable: DocTable = new DocTable({
      configuration,
      headerTitles: ['Enumeration', 'Description'],
      cssClass: 'enum-list',
      caption: 'List of enums contained in this package or namespace'
    });

    const functionsTable: DocTable = new DocTable({
      configuration,
      headerTitles: ['Function', 'Description'],
      cssClass: 'function-list',
      caption: 'List of functions contained in this package or namespace'
    });

    const interfacesTable: DocTable = new DocTable({
      configuration,
      headerTitles: ['Interface', 'Description'],
      cssClass: 'interface-list',
      caption: 'List of interfaces contained in this package or namespace'
    });

    const namespacesTable: DocTable = new DocTable({
      configuration,
      headerTitles: ['Namespace', 'Description'],
      cssClass: 'namespace-list',
      caption: 'List of namespaces contained in this package or namespace'
    });

    const variablesTable: DocTable = new DocTable({
      configuration,
      headerTitles: ['Variable', 'Description'],
      cssClass: 'variable-list',
      caption: 'List of variables contained in this package or namespace'
    });

    const typeAliasesTable: DocTable = new DocTable({
      configuration,
      headerTitles: ['Type Alias', 'Description'],
      cssClass: 'alias-list',
      caption: 'List of type aliases contained in this package or namespace'
    });

    const enumsParagraph: DocParagraph = new DocParagraph({ configuration });
    const varsParagraph: DocParagraph = new DocParagraph({ configuration });
    const functionsParagraph: DocParagraph = new DocParagraph({ configuration });
    const aliasesParagraph: DocParagraph = new DocParagraph({ configuration });

    const apiMembers: ReadonlyArray<ApiItem> =
      apiContainer.kind === ApiItemKind.Package
        ? (apiContainer as ApiPackage).entryPoints[0].members
        : (apiContainer as ApiNamespace).members;

    // loop through the members of the package/namespace.
    for (const apiMember of apiMembers) {
      const row: DocTableRow = new DocTableRow({ configuration }, [
        this._createTitleCell(apiMember),
        this._createDescriptionCell(apiMember)
      ]);

      switch (apiMember.kind) {
        case ApiItemKind.Class:
          classesTable.addRow(row);
          this._writeApiItemPage(apiMember);
          break;

        case ApiItemKind.Enum:
          enumerationsTable.addRow(row);
          this._writeApiItemPage(apiMember, enumsParagraph);
          break;

        case ApiItemKind.Interface:
          interfacesTable.addRow(row);
          this._writeApiItemPage(apiMember);
          break;

        case ApiItemKind.Namespace:
          namespacesTable.addRow(row);
          this._writeApiItemPage(apiMember, output);
          break;

        case ApiItemKind.Function:
          functionsTable.addRow(row);
          this._writeApiItemPage(apiMember, functionsParagraph);
          break;

        case ApiItemKind.TypeAlias:
          typeAliasesTable.addRow(row);
          this._writeApiItemPage(apiMember, aliasesParagraph);
          break;

        case ApiItemKind.Variable:
          variablesTable.addRow(row);
          this._writeApiItemPage(apiMember, varsParagraph);
          break;
      }
    }

    if (classesTable.rows.length > 0) {
      output.appendNode(new DocHeading({ configuration: this._tsdocConfiguration, title: 'Classes' }));
      output.appendNode(classesTable);
    }

    if (enumerationsTable.rows.length > 0) {
      output.appendNode(new DocHeading({ configuration: this._tsdocConfiguration, title: 'Enumerations' }));
      output.appendNode(enumerationsTable);
    }
    if (functionsTable.rows.length > 0) {
      output.appendNode(new DocHeading({ configuration: this._tsdocConfiguration, title: 'Functions' }));
      output.appendNode(functionsTable);
    }

    if (interfacesTable.rows.length > 0) {
      output.appendNode(new DocHeading({ configuration: this._tsdocConfiguration, title: 'Interfaces' }));
      output.appendNode(interfacesTable);
    }

    if (namespacesTable.rows.length > 0) {
      output.appendNode(new DocHeading({ configuration: this._tsdocConfiguration, title: 'Namespaces' }));
      output.appendNode(namespacesTable);
    }

    if (variablesTable.rows.length > 0) {
      output.appendNode(new DocHeading({ configuration: this._tsdocConfiguration, title: 'Variables' }));
      output.appendNode(variablesTable);
    }

    if (typeAliasesTable.rows.length > 0) {
      output.appendNode(new DocHeading({ configuration: this._tsdocConfiguration, title: 'Type Aliases' }));
      output.appendNode(typeAliasesTable);
    }

    const details: DocSection = new DocSection({ configuration }, [
      new DocHtmlStartTag({ configuration: this._tsdocConfiguration, name: 'hr' }),
      new DocHtmlStartTag({
        configuration: this._tsdocConfiguration,
        name: 'div',
        htmlAttributes: [
          new DocHtmlAttribute({
            configuration: this._tsdocConfiguration,
            name: 'id',
            value: 'package-details'
          })
        ]
      })
    ]);

    if (enumsParagraph.nodes.length > 0) {
      details.appendNode(new DocHeading({ configuration, title: 'Enumerations' }));
      details.appendNode(enumsParagraph);
    }

    if (functionsParagraph.nodes.length > 0) {
      details.appendNode(new DocHeading({ configuration, title: 'Functions' }));
      details.appendNode(functionsParagraph);
    }

    if (varsParagraph.nodes.length > 0) {
      details.appendNode(new DocHeading({ configuration, title: 'Variables' }));
      details.appendNode(varsParagraph);
    }

    if (aliasesParagraph.nodes.length > 0) {
      details.appendNode(new DocHeading({ configuration, title: 'Type Aliases' }));
      details.appendNode(aliasesParagraph);
    }

    details.appendNode(
      new DocHtmlEndTag({
        configuration,
        name: 'div'
      })
    );

    output.appendNode(details);
  }

  /**
   * GENERATE PAGE: CLASS
   */
  protected _writeClassTables(output: DocSection | DocParagraph, apiClass: ApiClass): void {
    const configuration: TSDocConfiguration = this._tsdocConfiguration;

    const eventsTable: DocTable = new DocTable({
      configuration,
      headerTitles: ['Property', 'Modifiers', 'Type', 'Description'],
      cssClass: 'event-list',
      caption: 'List of events in use in this class'
    });

    const constructorsTable: DocTable = new DocTable({
      configuration,
      headerTitles: ['Constructor', 'Modifiers', 'Description'],
      cssClass: 'constructor-list',
      caption: 'List of constructors for this class'
    });

    const propertiesTable: DocTable = new DocTable({
      configuration,
      headerTitles: ['Property', 'Modifiers', 'Type', 'Description'],
      cssClass: 'property-list',
      caption: 'List of properties for this class'
    });

    const methodsTable: DocTable = new DocTable({
      configuration,
      headerTitles: ['Method', 'Modifiers', 'Description'],
      cssClass: 'method-list',
      caption: 'List of methods on this class'
    });

    const constructorsParagraph: DocParagraph = new DocParagraph({ configuration });
    const methodsParagraph: DocParagraph = new DocParagraph({ configuration });
    const propertiesParagraph: DocParagraph = new DocParagraph({ configuration });
    const eventsParagraph: DocParagraph = new DocParagraph({ configuration });

    for (const apiMember of apiClass.members) {
      switch (apiMember.kind) {
        case ApiItemKind.Constructor: {
          constructorsTable.addRow(
            new DocTableRow({ configuration }, [
              this._createTitleCell(apiMember),
              this._createModifiersCell(apiMember),
              this._createDescriptionCell(apiMember)
            ])
          );

          this._writeApiItemPage(apiMember);
          break;
        }
        case ApiItemKind.Method: {
          methodsTable.addRow(
            new DocTableRow({ configuration }, [
              this._createTitleCell(apiMember),
              this._createModifiersCell(apiMember),
              this._createDescriptionCell(apiMember)
            ])
          );

          this._writeApiItemPage(apiMember, methodsParagraph);
          break;
        }
        case ApiItemKind.Property: {
          if ((apiMember as ApiPropertyItem).isEventProperty) {
            eventsTable.addRow(
              new DocTableRow({ configuration }, [
                this._createTitleCell(apiMember),
                this._createModifiersCell(apiMember),
                this._createPropertyTypeCell(apiMember),
                this._createDescriptionCell(apiMember)
              ])
            );
            this._writeApiItemPage(apiMember, eventsParagraph);
          } else {
            propertiesTable.addRow(
              new DocTableRow({ configuration }, [
                this._createTitleCell(apiMember),
                this._createModifiersCell(apiMember),
                this._createPropertyTypeCell(apiMember),
                this._createDescriptionCell(apiMember)
              ])
            );
            this._writeApiItemPage(apiMember, propertiesParagraph);
          }

          break;
        }
      }
    }

    if (eventsTable.rows.length > 0) {
      output.appendNode(new DocHeading({ configuration: this._tsdocConfiguration, title: 'Events' }));
      output.appendNode(eventsTable);
    }

    if (constructorsTable.rows.length > 0) {
      output.appendNode(new DocHeading({ configuration: this._tsdocConfiguration, title: 'Constructors' }));
      output.appendNode(constructorsTable);
    }

    if (propertiesTable.rows.length > 0) {
      output.appendNode(new DocHeading({ configuration: this._tsdocConfiguration, title: 'Properties' }));
      output.appendNode(propertiesTable);
    }

    if (methodsTable.rows.length > 0) {
      output.appendNode(new DocHeading({ configuration: this._tsdocConfiguration, title: 'Methods' }));
      output.appendNode(methodsTable);
    }

    const details: DocSection = new DocSection({ configuration: this._tsdocConfiguration }, [
      new DocHtmlStartTag({ configuration: this._tsdocConfiguration, name: 'hr' }),
      new DocHtmlStartTag({
        configuration: this._tsdocConfiguration,
        name: 'div',
        htmlAttributes: [
          new DocHtmlAttribute({
            configuration: this._tsdocConfiguration,
            name: 'id',
            value: 'class-details'
          })
        ]
      })
    ]);

    if (eventsParagraph.nodes.length > 0) {
      details.appendNode(new DocHeading({ configuration: this._tsdocConfiguration, title: 'Events' }));
      details.appendNode(eventsParagraph);
    }

    if (constructorsParagraph.nodes.length > 0) {
      details.appendNode(new DocHeading({ configuration: this._tsdocConfiguration, title: 'Constructors' }));
      details.appendNode(constructorsParagraph);
    }

    if (propertiesParagraph.nodes.length > 0) {
      details.appendNode(new DocHeading({ configuration: this._tsdocConfiguration, title: 'Properties' }));
      details.appendNode(propertiesParagraph);
    }

    if (methodsParagraph.nodes.length > 0) {
      details.appendNode(new DocHeading({ configuration: this._tsdocConfiguration, title: 'Methods' }));
      details.appendNode(methodsParagraph);
    }

    details.appendNode(
      new DocHtmlEndTag({
        configuration: this._tsdocConfiguration,
        name: 'div'
      })
    );

    output.appendNode(details);
  }

  /**
   * GENERATE PAGE: ENUM
   */
  protected _writeEnumTables(output: DocSection | DocParagraph, apiEnum: ApiEnum): void {
    const configuration: TSDocConfiguration = this._tsdocConfiguration;

    const enumMembersTable: DocTable = new DocTable({
      configuration,
      headerTitles: ['Member', 'Value', 'Description'],
      cssClass: 'enum-list',
      caption: 'List of members in use in this enum'
    });

    for (const apiEnumMember of apiEnum.members) {
      enumMembersTable.addRow(
        new DocTableRow({ configuration }, [
          new DocTableCell({ configuration }, [
            new DocParagraph({ configuration }, [
              new DocPlainText({ configuration, text: Utilities.getConciseSignature(apiEnumMember) })
            ])
          ]),

          new DocTableCell({ configuration }, [
            new DocParagraph({ configuration }, [
              new DocCodeSpan({ configuration, code: apiEnumMember.initializerExcerpt.text })
            ])
          ]),

          this._createDescriptionCell(apiEnumMember)
        ])
      );
    }

    if (enumMembersTable.rows.length > 0) {
      output.appendNode(
        new DocHeading({ configuration: this._tsdocConfiguration, title: 'Enumeration Members' })
      );
      output.appendNode(enumMembersTable);
    }
  }

  /**
   * GENERATE PAGE: INTERFACE
   */
  protected _writeInterfaceTables(output: DocSection | DocParagraph, apiClass: ApiInterface): void {
    const configuration: TSDocConfiguration = this._tsdocConfiguration;

    const eventsTable: DocTable = new DocTable({
      configuration,
      headerTitles: ['Property', 'Type', 'Description'],
      cssClass: 'event-list',
      caption: 'List of events in use in this interface'
    });

    const propertiesTable: DocTable = new DocTable({
      configuration,
      headerTitles: ['Property', 'Type', 'Description'],
      cssClass: 'property-list',
      caption: 'List of properties of this interface'
    });

    const methodsTable: DocTable = new DocTable({
      configuration,
      headerTitles: ['Method', 'Description'],
      cssClass: 'method-list',
      caption: 'List of methods of this class'
    });

    const eventsParagraph: DocParagraph = new DocParagraph({ configuration });
    const propertiesParagraph: DocParagraph = new DocParagraph({ configuration });
    const methodsParagraph: DocParagraph = new DocParagraph({ configuration });

    for (const apiMember of apiClass.members) {
      switch (apiMember.kind) {
        case ApiItemKind.ConstructSignature:
        case ApiItemKind.MethodSignature: {
          methodsTable.addRow(
            new DocTableRow({ configuration }, [
              this._createTitleCell(apiMember),
              this._createDescriptionCell(apiMember)
            ])
          );

          this._writeApiItemPage(apiMember, methodsParagraph);
          break;
        }
        case ApiItemKind.PropertySignature: {
          if ((apiMember as ApiPropertyItem).isEventProperty) {
            eventsTable.addRow(
              new DocTableRow({ configuration }, [
                this._createTitleCell(apiMember),
                this._createPropertyTypeCell(apiMember),
                this._createDescriptionCell(apiMember)
              ])
            );
            this._writeApiItemPage(apiMember, propertiesParagraph);
          } else {
            propertiesTable.addRow(
              new DocTableRow({ configuration }, [
                this._createTitleCell(apiMember),
                this._createPropertyTypeCell(apiMember),
                this._createDescriptionCell(apiMember)
              ])
            );
            this._writeApiItemPage(apiMember, eventsParagraph);
          }

          this._writeApiItemPage(apiMember);
          break;
        }
      }
    }

    if (eventsTable.rows.length > 0) {
      output.appendNode(new DocHeading({ configuration: this._tsdocConfiguration, title: 'Events' }));
      output.appendNode(eventsTable);
    }

    if (propertiesTable.rows.length > 0) {
      output.appendNode(new DocHeading({ configuration: this._tsdocConfiguration, title: 'Properties' }));
      output.appendNode(propertiesTable);
    }

    if (methodsTable.rows.length > 0) {
      output.appendNode(new DocHeading({ configuration: this._tsdocConfiguration, title: 'Methods' }));
      output.appendNode(methodsTable);
    }

    const details: DocSection = new DocSection({ configuration: this._tsdocConfiguration }, [
      new DocHtmlStartTag({ configuration: this._tsdocConfiguration, name: 'hr' }),
      new DocHtmlStartTag({
        configuration: this._tsdocConfiguration,
        name: 'div',
        htmlAttributes: [
          new DocHtmlAttribute({
            configuration: this._tsdocConfiguration,
            name: 'id',
            value: 'interface-details'
          })
        ]
      })
    ]);

    if (eventsParagraph.nodes.length > 0) {
      details.appendNode(new DocHeading({ configuration: this._tsdocConfiguration, title: 'Events' }));
      details.appendNode(eventsParagraph);
    }

    if (propertiesParagraph.nodes.length > 0) {
      details.appendNode(new DocHeading({ configuration: this._tsdocConfiguration, title: 'Properties' }));
      details.appendNode(propertiesParagraph);
    }

    if (methodsParagraph.nodes.length > 0) {
      details.appendNode(new DocHeading({ configuration: this._tsdocConfiguration, title: 'Methods' }));
      details.appendNode(methodsParagraph);
    }

    details.appendNode(
      new DocHtmlEndTag({
        configuration: this._tsdocConfiguration,
        name: 'div'
      })
    );

    output.appendNode(details);
  }

  /**
   * GENERATE PAGE: FUNCTION-LIKE
   */
  protected _writeParameterTables(
    output: DocSection | DocParagraph,
    apiParameterListMixin: ApiParameterListMixin
  ): void {
    const configuration: TSDocConfiguration = this._tsdocConfiguration;

    const parametersTable: DocTable = new DocTable({
      configuration,
      headerTitles: ['Parameter', 'Type', 'Description'],
      cssClass: 'param-list',
      caption: 'List of parameters'
    });
    for (const apiParameter of apiParameterListMixin.parameters) {
      const parameterDescription: DocSection = new DocSection({ configuration });
      if (apiParameter.tsdocParamBlock) {
        this._appendSection(parameterDescription, apiParameter.tsdocParamBlock.content);
      }

      parametersTable.addRow(
        new DocTableRow({ configuration }, [
          new DocTableCell({ configuration }, [
            new DocParagraph({ configuration }, [
              new DocPlainText({ configuration, text: apiParameter.name })
            ])
          ]),
          new DocTableCell({ configuration }, [
            this._createParagraphForTypeExcerpt(apiParameter.parameterTypeExcerpt)
          ]),
          new DocTableCell({ configuration }, parameterDescription.nodes)
        ])
      );
    }

    if (parametersTable.rows.length > 0) {
      output.appendNode(
        new DocHeading({ configuration: this._tsdocConfiguration, title: 'Parameters', level: 4 })
      );
      output.appendNode(parametersTable);
    }

    if (ApiReturnTypeMixin.isBaseClassOf(apiParameterListMixin)) {
      const returnTypeExcerpt: Excerpt = apiParameterListMixin.returnTypeExcerpt;
      output.appendNode(
        new DocParagraph({ configuration }, [
          new DocEmphasisSpan({ configuration, bold: true }, [
            new DocPlainText({ configuration, text: 'Returns:' })
          ])
        ])
      );

      output.appendNode(this._createParagraphForTypeExcerpt(returnTypeExcerpt));

      if (apiParameterListMixin instanceof ApiDocumentedItem) {
        if (apiParameterListMixin.tsdocComment && apiParameterListMixin.tsdocComment.returnsBlock) {
          this._appendSection(output, apiParameterListMixin.tsdocComment.returnsBlock.content);
        }
      }
    }
  }

  // protected _createParagraphForTypeExcerpt(excerpt: Excerpt): DocParagraph {
  //   const configuration: TSDocConfiguration = this._tsdocConfiguration;

  //   const paragraph: DocParagraph = new DocParagraph({ configuration });

  //   if (!excerpt.text.trim()) {
  //     paragraph.appendNode(new DocPlainText({ configuration, text: '(not declared)' }));
  //   } else {
  //     this._appendExcerptWithHyperlinks(paragraph, excerpt);
  //   }

  //   return paragraph;
  // }

  protected _appendExcerptWithHyperlinks(docNodeContainer: DocNodeContainer, excerpt: Excerpt): void {
    const configuration: TSDocConfiguration = this._tsdocConfiguration;

    for (const token of excerpt.spannedTokens) {
      // Markdown doesn't provide a standardized syntax for hyperlinks inside code spans, so we will render
      // the type expression as DocPlainText.  Instead of creating multiple DocParagraphs, we can simply
      // discard any newlines and let the renderer do normal word-wrapping.
      const unwrappedTokenText: string = token.text.replace(/[\r\n]+/g, ' ');

      // If it's hyperlinkable, then append a DocLinkTag
      if (token.kind === ExcerptTokenKind.Reference && token.canonicalReference) {
        const apiItemResult: IResolveDeclarationReferenceResult = this._apiModel.resolveDeclarationReference(
          token.canonicalReference,
          undefined
        );

        if (apiItemResult.resolvedApiItem) {
          docNodeContainer.appendNode(
            new DocLinkTag({
              configuration,
              tagName: '@link',
              linkText: unwrappedTokenText,
              urlDestination: this._getLinkFilenameForApiItem(apiItemResult.resolvedApiItem)
            })
          );
          continue;
        }
      }

      // Otherwise append non-hyperlinked text
      docNodeContainer.appendNode(new DocPlainText({ configuration, text: unwrappedTokenText }));
    }
  }

  // protected _appendExcerptTokenWithHyperlinks(docNodeContainer: DocNodeContainer, token: ExcerptToken): void {
  //   const configuration: TSDocConfiguration = this._tsdocConfiguration;

  //   for (const token of excerpt.spannedTokens) {
  //     // Markdown doesn't provide a standardized syntax for hyperlinks inside code spans, so we will render
  //     // the type expression as DocPlainText.  Instead of creating multiple DocParagraphs, we can simply
  //     // discard any newlines and let the renderer do normal word-wrapping.
  //     const unwrappedTokenText: string = token.text.replace(/[\r\n]+/g, ' ');

  //     // If it's hyperlinkable, then append a DocLinkTag
  //     if (token.kind === ExcerptTokenKind.Reference && token.canonicalReference) {
  //       const apiItemResult: IResolveDeclarationReferenceResult = this._apiModel.resolveDeclarationReference(
  //         token.canonicalReference,
  //         undefined
  //       );

  //       if (apiItemResult.resolvedApiItem) {
  //         docNodeContainer.appendNode(
  //           new DocLinkTag({
  //             configuration,
  //             tagName: '@link',
  //             linkText: unwrappedTokenText,
  //             urlDestination: this._getLinkFilenameForApiItem(apiItemResult.resolvedApiItem)
  //           })
  //         );
  //         continue;
  //       }
  //     }

  //     // Otherwise append non-hyperlinked text
  //     docNodeContainer.appendNode(new DocPlainText({ configuration, text: unwrappedTokenText }));
  //   }
  // }

  protected _createTitleCell(apiItem: ApiItem): DocTableCell {
    const configuration: TSDocConfiguration = this._tsdocConfiguration;

    return new DocTableCell({ configuration }, [
      new DocParagraph({ configuration }, [
        new DocLinkTag({
          configuration,
          tagName: '@link',
          linkText: Utilities.getConciseSignature(apiItem),
          urlDestination: this._getLinkFilenameForApiItem(apiItem)
        })
      ])
    ]);
  }

  // prepare the markdown frontmatter by providing the metadata needed to nicely render the page.
  protected _writeFrontMatter(stringBuilder: StringBuilder, item: ApiItem): void {
    this._frontMatter.kind = item.kind;
    this._frontMatter.title = item.displayName.replace(/"/g, '').replace(/!/g, '');
    let apiMembers: ReadonlyArray<ApiItem> = item.members;
    const mdEmitter = this._markdownEmitter;

    let extractSummary = (docComment: DocComment): string => {
      const tmpStrBuilder: StringBuilder = new StringBuilder();
      const summary: DocSection = docComment!.summarySection;
      mdEmitter.emit(tmpStrBuilder, summary, {
        contextApiItem: item,
        onGetFilenameForApiItem: (apiItemForFilename: ApiItem) => {
          return this._getLinkFilenameForApiItem(apiItemForFilename);
        }
      });
      return tmpStrBuilder.toString().replace(/"/g, "'").trim();
    };
    switch (item.kind) {
      case ApiItemKind.Class:
        const classItem: ApiClass = item as ApiClass;
        if (classItem.tsdocComment) {
          this._frontMatter.summary = extractSummary(classItem.tsdocComment);
        }
        this._frontMatter.title += ' Class';
        break;
      case ApiItemKind.Interface:
        this._frontMatter.title += ' Interface';
        const interfaceItem: ApiInterface = item as ApiInterface;
        if (interfaceItem.tsdocComment) {
          this._frontMatter.summary = extractSummary(interfaceItem.tsdocComment);
        }
        break;
      case ApiItemKind.Package:
        this._frontMatter.title += ' Package';
        apiMembers =
          item.kind === ApiItemKind.Package
            ? (item as ApiPackage).entryPoints[0].members
            : (item as ApiNamespace).members;
        const pkgItem: ApiPackage = item as ApiPackage;
        if (pkgItem.tsdocComment) {
          this._frontMatter.summary = extractSummary(pkgItem.tsdocComment);
        }
        break;
      default:
        break;
    }

    this._frontMatter.members = new Map<string, Map<string, string>>();
    apiMembers.forEach((element) => {
      if (element.displayName === '') {
        return;
      }
      if (this._frontMatter && this._frontMatter.members) {
        if (!this._frontMatter.members.get(element.kind)) {
          this._frontMatter.members.set(element.kind, new Map<string, string>());
        }
        this._frontMatter.members
          .get(element.kind)
          ?.set(element.displayName, this._getLinkFilenameForApiItem(element));
      }
    });

    const pkg: ApiPackage | undefined = item.getAssociatedPackage();
    if (pkg) {
      this._frontMatter.package = pkg.name.replace(/"/g, '').replace(/!/g, '');
    } else {
      this._frontMatter.package = 'undefined';
    }
    // this._frontMatter.members = this._frontMatter.members;

    stringBuilder.append(JSON.stringify(this._frontMatter));
    stringBuilder.append(
      '\n\n[//]: # (Do not edit this file. It is automatically generated by API Documenter.)\n\n'
    );
  }

  protected _writeBreadcrumb(output: DocSection, apiItem: ApiItem): void {
    // no breadcrumbs for inner content
    if (
      apiItem.kind !== ApiItemKind.Package &&
      apiItem.kind !== ApiItemKind.Class &&
      apiItem.kind !== ApiItemKind.Interface
    ) {
      return;
    }

    output.appendNodeInParagraph(
      new DocLinkTag({
        configuration: this._tsdocConfiguration,
        tagName: '@link',
        linkText: 'Packages',
        urlDestination: this._getLinkFilenameForApiItem(this._apiModel)
      })
    );

    for (const hierarchyItem of apiItem.getHierarchy()) {
      switch (hierarchyItem.kind) {
        case ApiItemKind.Model:
        case ApiItemKind.EntryPoint:
          // We don't show the model as part of the breadcrumb because it is the root-level container.
          // We don't show the entry point because today API Extractor doesn't support multiple entry points;
          // this may change in the future.
          break;
        default:
          output.appendNodesInParagraph([
            new DocPlainText({
              configuration: this._tsdocConfiguration,
              text: ' > '
            }),
            new DocLinkTag({
              configuration: this._tsdocConfiguration,
              tagName: '@link',
              linkText: hierarchyItem.displayName,
              urlDestination: this._getLinkFilenameForApiItem(hierarchyItem)
            })
          ]);
      }
    }
  }

  protected _getFilenameForApiItem(apiItem: ApiItem, linkToMD?: boolean): string {
    if (apiItem.kind === ApiItemKind.Model) {
      return '/';
    }

    let baseName: string = '';
    for (const hierarchyItem of apiItem.getHierarchy()) {
      // For overloaded methods, add a suffix such as "MyClass.myMethod_2".
      let qualifiedName: string = Utilities.getSafeFilenameForName(hierarchyItem.displayName);
      if (ApiParameterListMixin.isBaseClassOf(hierarchyItem)) {
        if (hierarchyItem.overloadIndex > 1) {
          // Subtract one for compatibility with earlier releases of API Documenter.
          // (This will get revamped when we fix GitHub issue #1308)
          qualifiedName += `_${hierarchyItem.overloadIndex - 1}`;
        }
      }

      switch (hierarchyItem.kind) {
        case ApiItemKind.Model:
        case ApiItemKind.EntryPoint:
          break;
        case ApiItemKind.Package:
          baseName = Utilities.getSafeFilenameForName(PackageName.getUnscopedName(hierarchyItem.displayName));
          break;
        default:
          baseName += '/' + qualifiedName;
      }
    }

    switch (apiItem.kind) {
      case ApiItemKind.Method:
      case ApiItemKind.Property:
      case ApiItemKind.Function:
      case ApiItemKind.Variable:
        return '#' + baseName;
        break;
      default:
        return baseName + '.md';
    }
  }

  private _htmlIDForItem(apiItem: ApiItem): string {
    if (apiItem.kind === ApiItemKind.Model) {
      return '';
    }

    let baseName: string = '';
    for (const hierarchyItem of apiItem.getHierarchy()) {
      let qualifiedName: string = Utilities.getSafeFilenameForName(hierarchyItem.displayName);
      if (ApiParameterListMixin.isBaseClassOf(hierarchyItem)) {
        if (hierarchyItem.overloadIndex > 1) {
          qualifiedName += `_${hierarchyItem.overloadIndex - 1}`;
        }
      }

      switch (hierarchyItem.kind) {
        case ApiItemKind.Model:
        case ApiItemKind.EntryPoint:
          break;
        case ApiItemKind.Package:
          baseName = Utilities.getSafeFilenameForName(PackageName.getUnscopedName(hierarchyItem.displayName));
          break;
        default:
          baseName += '-' + qualifiedName;
      }
    }
    return baseName + '-' + apiItem.kind;
  }

  protected _getLinkFilenameForApiItem(apiItem: ApiItem): string {
    if (apiItem.kind === ApiItemKind.Model) {
      return this._uriRoot;
    }
    if (this._shouldHaveStandalonePage(apiItem)) {
      return this._uriRoot + this._getFilenameForApiItem(apiItem);
    } else {
      return this._getHrefForApiItem(apiItem);
    }
  }

  private _shouldHaveStandalonePage(apiItem: ApiItem): boolean {
    return (
      apiItem.kind === ApiItemKind.Package ||
      apiItem.kind === ApiItemKind.Class ||
      apiItem.kind === ApiItemKind.Interface
    );
  }

  private _isAllowedPackage(pkg: ApiPackage): boolean {
    const config = this._documenterConfig;
    if (config && config.onlyPackagesStartingWith) {
      if (typeof config.onlyPackagesStartingWith === 'string') {
        return pkg.name.startsWith(config.onlyPackagesStartingWith);
      } else {
        return config.onlyPackagesStartingWith.some((prefix) => pkg.name.startsWith(prefix));
      }
    }
    return true;
  }

  private _getHrefForApiItem(apiItem: ApiItem): string {
    if (this._currentApiItemPage !== apiItem.parent) {
      // we need to build the href linking to the parent's page, not the current's page.
      return (
        this._uriRoot +
        this._getFilenameForApiItem(apiItem.parent!).replace(/\.md/g, '/') +
        '#' +
        this._htmlIDForItem(apiItem)
      );
    }
    return '#' + this._htmlIDForItem(apiItem);
  }
}
