import type { KyselyPlugin, OperationNode, PluginTransformQueryArgs, PluginTransformResultArgs, QueryResult, RootOperationNode, UnknownRow } from 'kysely';
import {
  AliasNode,
  AndNode,
  BinaryOperationNode,
  ColumnNode,
  DeleteQueryNode,
  FromNode,
  IdentifierNode,
  InsertQueryNode,
  JoinNode,
  OnNode,
  OperationNodeTransformer,
  OperatorNode,
  ReferenceNode,
  SelectAllNode,
  SelectionNode,
  SelectQueryNode,
  TableNode,
  UpdateQueryNode,
  ValueNode,
  WhereNode,
} from 'kysely';
import type { AnyColSchema, InferInsert, InferSelect, SchemaTable, TableOptions } from './schema.js';

export interface VirtualTableJoin<
  JCols extends Record<string, AnyColSchema> = Record<string, AnyColSchema>,
  JK extends keyof JCols & string = keyof JCols & string,
> {
  readonly table: SchemaTable<JCols, any>;
  readonly on: readonly [string, string];
  readonly columns: readonly JK[];
  readonly type?: 'inner' | 'left';
}

type JoinedColumns<Joins extends readonly VirtualTableJoin<any, any>[]> =
  Joins extends readonly [infer First extends VirtualTableJoin<any, any>, ...infer Rest extends readonly VirtualTableJoin<any, any>[]]
    ? Pick<First['table']['_columns'], First['columns'][number]> & JoinedColumns<Rest>
    : object;

export interface VirtualTable<
  Cols extends Record<string, AnyColSchema>,
  O extends TableOptions = object,
> {
  readonly _name: string;
  readonly _columns: Cols;
  readonly _options: O;
  readonly _source: SchemaTable<any, any>;
  readonly _where: Record<string, unknown> | undefined;
  readonly _joins: readonly VirtualTableJoin<any, any>[];
  $inferSelect: InferSelect<Cols, O>;
  $inferInsert: InferInsert<Cols, O>;
}

export function defineVirtualTable<
  Cols extends Record<string, AnyColSchema>,
  O extends TableOptions,
  K extends keyof Cols & string,
  const Joins extends readonly VirtualTableJoin<any, any>[] = [],
>(
  name: string,
  source: SchemaTable<Cols, O>,
  columns: K[],
  options?: { where?: Record<string, unknown>; joins?: Joins },
): VirtualTable<Pick<Cols, K> & JoinedColumns<Joins>, O> {
  const picked = Object.fromEntries(
    columns.map(k => [k, source._columns[k]]),
  ) as Pick<Cols, K>;

  const joins = options?.joins ?? ([] as unknown as Joins);
  const joinedColumns: Record<string, AnyColSchema> = {};
  for (const join of joins) {
    for (const col of join.columns) {
      joinedColumns[col] = join.table._columns[col];
    }
  }

  return {
    _name: name,
    _columns: { ...picked, ...joinedColumns },
    _options: source._options,
    _source: source,
    _where: options?.where,
    _joins: joins,
  } as unknown as VirtualTable<Pick<Cols, K> & JoinedColumns<Joins>, O>;
}

interface VtRef {
  vtName: string;
  vt: VirtualTable<any, any>;
  alias?: string;
}

class VirtualTableTransformer extends OperationNodeTransformer {
  constructor(private readonly vts: Map<string, VirtualTable<any, any>>) {
    super();
  }

  protected override transformSelectQuery(node: SelectQueryNode): SelectQueryNode {
    if (!node.from) return super.transformSelectQuery(node);

    let ref: VtRef | undefined;
    for (const from of node.from.froms) {
      ref = this.matchVt(from);
      if (ref) break;
    }

    if (!ref) return super.transformSelectQuery(node);
    const { vt } = ref;
    const primaryRef = ref.alias ?? vt._name;

    const newFroms = node.from.froms.map(f =>
      this.matchVt(f) ? this.buildPrimaryFrom(vt, ref!.alias) : f,
    );

    const joinNodes = vt._joins.map((j: VirtualTableJoin<any, any>) => this.buildJoin(j, primaryRef));
    const newJoins = [...joinNodes, ...(node.joins ?? [])];

    let newWhere = node.where;
    if (vt._where) {
      const vtWhereNode = this.buildWhere(vt._where, primaryRef);
      newWhere = node.where
        ? WhereNode.cloneWithOperation(node.where, 'And', vtWhereNode.where)
        : vtWhereNode;
    }

    const newSelections = node.selections?.flatMap(s => this.expandSelection(s, vt, primaryRef));

    return super.transformSelectQuery({
      ...node,
      from: FromNode.create(newFroms),
      joins: newJoins.length > 0 ? newJoins : node.joins,
      where: newWhere,
      selections: newSelections,
    });
  }

  protected override transformInsertQuery(node: InsertQueryNode): InsertQueryNode {
    if (node.into && this.vts.has(node.into.table.identifier.name)) {
      throw new Error(`Cannot insert into virtual table "${node.into.table.identifier.name}"`);
    }
    return super.transformInsertQuery(node);
  }

  protected override transformUpdateQuery(node: UpdateQueryNode): UpdateQueryNode {
    if (node.table && TableNode.is(node.table) && this.vts.has(node.table.table.identifier.name)) {
      throw new Error(`Cannot update virtual table "${node.table.table.identifier.name}"`);
    }
    return super.transformUpdateQuery(node);
  }

  protected override transformDeleteQuery(node: DeleteQueryNode): DeleteQueryNode {
    for (const from of node.from.froms) {
      if (TableNode.is(from) && this.vts.has(from.table.identifier.name)) {
        throw new Error(`Cannot delete from virtual table "${from.table.identifier.name}"`);
      }
    }
    return super.transformDeleteQuery(node);
  }

  private matchVt(node: OperationNode): VtRef | undefined {
    if (TableNode.is(node) && this.vts.has(node.table.identifier.name)) {
      const vtName = node.table.identifier.name;
      return { vtName, vt: this.vts.get(vtName)! };
    }
    if (AliasNode.is(node) && TableNode.is(node.node) && this.vts.has(node.node.table.identifier.name)) {
      const vtName = node.node.table.identifier.name;
      const alias = IdentifierNode.is(node.alias) ? node.alias.name : undefined;
      return { vtName, vt: this.vts.get(vtName)!, alias };
    }
    return undefined;
  }

  private buildPrimaryFrom(vt: VirtualTable<any, any>, alias: string | undefined): OperationNode {
    return AliasNode.create(TableNode.create(vt._source._name), IdentifierNode.create(alias ?? vt._name));
  }

  private expandSelection(selection: SelectionNode, vt: VirtualTable<any, any>, primaryRef: string): SelectionNode[] {
    const target = selection.selection;
    if (SelectAllNode.is(target)) return this.buildSelectAll(vt, primaryRef);
    if (!ReferenceNode.is(target) || !SelectAllNode.is(target.column) || !target.table) return [selection];

    const tableName = target.table.table.identifier.name;
    if (tableName === primaryRef || tableName === vt._name) return this.buildSelectAll(vt, primaryRef);

    const join = vt._joins.find((j: VirtualTableJoin<any, any>) => j.table._name === tableName);
    if (!join) return [selection];
    return this.joinSelections(join);
  }

  private joinSelections(join: VirtualTableJoin<any, any>): SelectionNode[] {
    return (join.columns as string[]).map(col =>
      SelectionNode.create(ReferenceNode.create(ColumnNode.create(col), TableNode.create(join.table._name))),
    );
  }

  private buildJoin(join: VirtualTableJoin<any, any>, primaryRef: string): JoinNode {
    const [primaryCol, joinedCol] = join.on;
    const on = BinaryOperationNode.create(
      ReferenceNode.create(ColumnNode.create(primaryCol), TableNode.create(primaryRef)),
      OperatorNode.create('='),
      ReferenceNode.create(ColumnNode.create(joinedCol), TableNode.create(join.table._name)),
    );
    const joinType = join.type === 'left' ? 'LeftJoin' : 'InnerJoin';
    return JoinNode.createWithOn(joinType, TableNode.create(join.table._name), OnNode.create(on));
  }

  private buildWhere(filter: Record<string, unknown>, primaryRef: string): WhereNode {
    const conditions = Object.entries(filter).map(([col, val]) =>
      BinaryOperationNode.create(
        ReferenceNode.create(ColumnNode.create(col), TableNode.create(primaryRef)),
        OperatorNode.create('='),
        ValueNode.create(val),
      ),
    );
    const combined = (conditions as OperationNode[]).reduce((left, right) => AndNode.create(left, right));
    return WhereNode.create(combined);
  }

  private buildSelectAll(vt: VirtualTable<any, any>, primaryRef: string): SelectionNode[] {
    const joinedCols = new Set<string>(vt._joins.flatMap((j: VirtualTableJoin<any, any>) => j.columns as string[]));
    const ownCols = [...this.autoColumns(vt), ...Object.keys(vt._columns).filter(c => !joinedCols.has(c))];

    const ownSelections = ownCols.map(col =>
      SelectionNode.create(ReferenceNode.create(ColumnNode.create(col), TableNode.create(primaryRef))),
    );
    const joinedSelections = vt._joins.flatMap((j: VirtualTableJoin<any, any>) => this.joinSelections(j));

    return [...ownSelections, ...joinedSelections];
  }

  private autoColumns(vt: VirtualTable<any, any>): string[] {
    const o = vt._options as Record<string, unknown>;
    const cols: string[] = [];
    if (o['primaryKey'] !== false) cols.push((o['primaryKeyColumn'] as string | undefined) ?? 'id');
    if (o['createdAt'] !== false) cols.push((o['createdAtColumn'] as string | undefined) ?? 'createdAt');
    if (o['updatedAt'] !== false) cols.push((o['updatedAtColumn'] as string | undefined) ?? 'updatedAt');
    return cols;
  }
}

export class VirtualTablePlugin implements KyselyPlugin {
  private readonly transformer: VirtualTableTransformer;

  constructor(virtualTables: VirtualTable<any, any>[]) {
    const map = new Map(virtualTables.map(vt => [vt._name, vt]));
    this.transformer = new VirtualTableTransformer(map);
  }

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return this.transformer.transformNode(args.node);
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return args.result;
  }
}
