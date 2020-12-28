/********************************************************************************
 * Copyright (C) 2019 Red Hat, Inc. and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

import { injectable } from 'inversify';
import { CancellationToken, CancellationTokenSource, Disposable, Emitter, Event } from '../common';
import { TernarySearchTree } from '../common/ternary-search-tree';
import URI from '../common/uri';

export interface DecorationsProvider {
    readonly label: string;
    readonly onDidChange: Event<URI[]>;
    provideDecorations(uri: URI, token: CancellationToken): Decoration | Promise<Decoration | undefined> | undefined;
}

export interface Decoration {
    readonly weight?: number;
    readonly color?: string;
    readonly letter?: string;
    readonly tooltip?: string;
    readonly bubble?: boolean;
}

export interface ResourceDecorationChangeEvent {
    affectsResource(uri: URI): boolean;
}
export const DecorationsService = Symbol('DecorationsService');
export interface DecorationsService {

    readonly onDidChangeDecorations: Event<ResourceDecorationChangeEvent>;

    registerDecorationsProvider(provider: DecorationsProvider): Disposable;

    getDecoration(uri: URI, includeChildren: boolean): Decoration [];
}

class DecorationDataRequest {
    constructor(
        readonly source: CancellationTokenSource,
        readonly thenable: Promise<void>,
    ) { }
}

class DecorationProviderWrapper {

    readonly data: TernarySearchTree<URI, DecorationDataRequest | Decoration | undefined>;
    private readonly disposable: Disposable;

    constructor(
        readonly provider: DecorationsProvider,
        private readonly uriEmitter: Emitter<URI | URI[]>,
        private readonly flushEmitter: Emitter<ResourceDecorationChangeEvent>
    ) {

        this.data = TernarySearchTree.forUris<DecorationDataRequest | Decoration | undefined>(true);

        this.disposable = this.provider.onDidChange(uris => {
            if (!uris) {
                // flush event -> drop all data, can affect everything
                this.data.clear();
                this.flushEmitter.fire({ affectsResource(): boolean { return true; } });

            } else {
                // selective changes -> drop for resource, fetch again, send event
                // perf: the map stores thenables, decorations, or `null`-markers.
                // we make us of that and ignore all uris in which we have never
                // been interested.
                for (const uri of uris) {
                    this.fetchData(new URI(uri.toString()));
                }
            }
        });
    }

    dispose(): void {
        this.disposable.dispose();
        this.data.clear();
    }

    knowsAbout(uri: URI): boolean {
        return !!this.data.get(uri) || Boolean(this.data.findSuperstr(uri));
    }

    getOrRetrieve(uri: URI, includeChildren: boolean, callback: (data: Decoration, isChild: boolean) => void): void {

        let item = this.data.get(uri);

        if (item === undefined) {
            // unknown -> trigger request
            item = this.fetchData(uri);
        }

        if (item && !(item instanceof DecorationDataRequest)) {
            // found something (which isn't pending anymore)
            callback(item, false);
        }

        if (includeChildren) {
            // (resolved) children
            const iter = this.data.findSuperstr(uri);
            if (iter) {
                let next = iter.next();
                while (!next.done) {
                    const value = next.value;
                    if (value && !(value instanceof DecorationDataRequest)) {
                        callback(value, true);
                    }
                    next = iter.next();
                }
            }
        }
    }

    private fetchData(uri: URI): Decoration | undefined {

        // check for pending request and cancel it
        const pendingRequest = this.data.get(new URI(uri.toString()));
        if (pendingRequest instanceof DecorationDataRequest) {
            pendingRequest.source.cancel();
            this.data.delete(uri);
        }

        const source = new CancellationTokenSource();
        const dataOrThenable = this.provider.provideDecorations(new URI(uri.toString()), source.token);
        if (!isThenable<Decoration | Promise<Decoration | undefined> | undefined>(dataOrThenable)) {
            // sync -> we have a result now
            return this.keepItem(uri, dataOrThenable);

        } else {
            // async -> we have a result soon
            const request = new DecorationDataRequest(source, Promise.resolve(dataOrThenable).then(data => {
                if (this.data.get(uri) === request) {
                    this.keepItem(uri, data);
                }
            }).catch(err => {
                if (!(err instanceof Error && err.name === 'Canceled' && err.message === 'Canceled') && this.data.get(uri) === request) {
                    this.data.delete(uri);
                }
            }));

            this.data.set(uri, request);
            return undefined;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        function isThenable<T>(obj: any): obj is Promise<T> {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return obj && typeof (<Promise<any>>obj).then === 'function';
        }
    }

    private keepItem(uri: URI, data: Decoration | undefined): Decoration | undefined {
        const deco = data ? data : undefined;
        const old = this.data.set(uri, deco);
        if (deco || old) {
            // only fire event when something changed
            this.uriEmitter.fire(uri);
        }
        return deco;
    }
}

@injectable()
export class DecorationsServiceImpl implements DecorationsService {

    private readonly data: DecorationProviderWrapper[] = [];
    private readonly onDidChangeDecorationsDelayedEmitter = new Emitter<URI | URI[]>();
    private readonly onDidChangeDecorationsEmitter = new Emitter<ResourceDecorationChangeEvent>();

    readonly onDidChangeDecorations = this.onDidChangeDecorationsEmitter.event;

    dispose(): void {
        this.onDidChangeDecorationsEmitter.dispose();
        this.onDidChangeDecorationsDelayedEmitter.dispose();
    }

    registerDecorationsProvider(provider: DecorationsProvider): Disposable {

        const wrapper = new DecorationProviderWrapper(
            provider,
            this.onDidChangeDecorationsDelayedEmitter,
            this.onDidChangeDecorationsEmitter
        );
        this.data.push(wrapper);

        this.onDidChangeDecorationsEmitter.fire({
            // everything might have changed
            affectsResource(): boolean { return true; }
        });

        return Disposable.create(() => {
            // fire event that says 'yes' for any resource
            // known to this provider. then dispose and remove it.
            this.data.splice(this.data.indexOf(wrapper), 1);
            this.onDidChangeDecorationsEmitter.fire({ affectsResource: uri => wrapper.knowsAbout(new URI(uri.toString())) });
            wrapper.dispose();
        });
    }

    getDecoration(uri: URI, includeChildren: boolean): Decoration [] {
        const data: Decoration[] = [];
        let containsChildren: boolean = false;
        for (const wrapper of this.data) {
            wrapper.getOrRetrieve(new URI(uri.toString()), includeChildren, (deco, isChild) => {
                if (!isChild || deco.bubble) {
                    data.push(deco);
                    containsChildren = isChild || containsChildren;
                }
            });
        }
        return data;
    }
}
