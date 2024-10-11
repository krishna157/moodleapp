// (C) Copyright 2015 Moodle Pty Ltd.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
import { Component, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { Subscription } from 'rxjs';
import { AddonBlockMyOverviewComponent } from '@addons/block/myoverview/components/myoverview/myoverview';
import { AsyncDirective } from '@classes/async-directive';
import { PageLoadsManager } from '@classes/page-loads-manager';
import { CorePromisedValue } from '@classes/promised-value';
import { CoreBlockComponent } from '@features/block/components/block/block';
import { CoreBlockDelegate } from '@features/block/services/block-delegate';
import { CoreCourseBlock } from '@features/course/services/course';
import { CoreCoursesDashboard, CoreCoursesDashboardProvider } from '@features/courses/services/dashboard';
import { CoreMainMenuDeepLinkManager } from '@features/mainmenu/classes/deep-link-manager';
import { CoreSites } from '@services/sites';
import { CoreDomUtils } from '@services/utils/dom';
import { CoreUtils } from '@services/utils/utils';
import { CoreEventObserver, CoreEvents } from '@singletons/events';
import { CoreTime } from '@singletons/time';
import { CoreAnalytics, CoreAnalyticsEventType } from '@services/analytics';
import { Translate } from '@singletons';
import { CoreWait } from '@singletons/wait';
import { CoreNavigator } from '@services/navigator';
import { CoreTabsOutletComponent, CoreTabsOutletTab } from '@components/tabs-outlet/tabs-outlet';
import { CoreMainMenuHomeDelegate, CoreMainMenuHomeHandlerToDisplay } from '../../services/home-delegate';
import { CoreMainMenuHomeHandlerService } from '@features/mainmenu/services/handlers/mainmenu';
import { CoreCourseListItem, CoreCourses } from '@features/courses/services/courses';
import { CoreSite } from '@classes/sites/site';

@Component({
    selector: 'page-core-mainmenu-home',
    templateUrl: 'home.html',
    providers: [{
        provide: PageLoadsManager,
        useClass: PageLoadsManager,
    }],
})
export class CoreMainMenuHomePage implements OnInit, OnDestroy, AsyncDirective {

    @ViewChild(CoreTabsOutletComponent) tabsComponent?: CoreTabsOutletComponent;
    @ViewChild(CoreBlockComponent) block!: CoreBlockComponent;

    siteName = '';
    downloadCoursesEnabled = false;

    tabs: CoreTabsOutletTab[] = [];
    loaded = false;
    searchEnabled = false;
    notificationEnabled = true;
    loadedBlock?: Partial<CoreCourseBlock>;
    myOverviewBlock?: AddonBlockMyOverviewComponent;
    myPageCourses = CoreCoursesDashboardProvider.MY_PAGE_COURSES;
    hasSideBlocks = false;
    userId: number;
    protected updateSiteObserver: CoreEventObserver;
    protected onReadyPromise = new CorePromisedValue<void>();
    protected loadsManagerSubscription: Subscription;
    protected logView: () => void;
    protected subscription?: Subscription;
    protected deepLinkManager?: CoreMainMenuDeepLinkManager;
    protected currentSite!: CoreSite;

    isLayoutSwitcherAvailable = true;
    layout: AddonBlockMyOverviewLayouts = 'card';
    loadFallbackCourseIcon(course: CoreCourseListItem): void {
        course.courseimage = undefined; // Handle fallback logic if the image fails to load
    }

    constructor(protected loadsManager: PageLoadsManager) {
        this.updateSiteObserver = CoreEvents.on(CoreEvents.SITE_UPDATED, async () => {
            this.downloadCoursesEnabled = !CoreCourses.isDownloadCoursesDisabledInSite();
            await this.loadSiteName();
        }, CoreSites.getCurrentSiteId());

        this.userId = CoreSites.getCurrentSiteUserId();

        this.loadsManagerSubscription = this.loadsManager.onRefreshPage.subscribe(() => {
            this.loaded = false;
            this.loadContent();
        });

        this.logView = CoreTime.once(async () => {
            await CoreUtils.ignoreErrors(CoreCourses.logView('my'));

            CoreAnalytics.logEvent({
                type: CoreAnalyticsEventType.VIEW_ITEM,
                ws: 'core_my_view_page',
                name: Translate.instant('core.courses.mycourses'),
                data: { category: 'course', page: 'my' },
                url: '/my/courses.php',
            });
        });
    }

    async ngOnInit(): Promise<void> {
        this.userId = CoreSites.getCurrentSiteUserId();
        this.deepLinkManager = new CoreMainMenuDeepLinkManager();

        await this.loadSiteName();
        this.loadContent(true);

        this.searchEnabled = this.checkIfSearchShouldBeEnabled();

        this.subscription = CoreMainMenuHomeDelegate.getHandlersObservable().subscribe((handlers) => {
            handlers && this.initHandlers(handlers);
        });

        // Load the current layout from site configuration
        const site = CoreSites.getCurrentSite();
        if (site) {
            this.layout = (await site.getLocalSiteConfig('AddonBlockMyOverviewLayout')) || 'card';
        }
    }

    protected checkIfSearchShouldBeEnabled(): boolean {
        return true;
    }

    async loadContent(firstLoad = false): Promise<void> {
        const loadWatcher = this.loadsManager.startPageLoad(this, !!firstLoad);
        const available = await CoreCoursesDashboard.isAvailable();
        const disabled = await CoreCourses.isMyCoursesDisabled();

        const supportsMyParam = !!CoreSites.getCurrentSite()?.isVersionGreaterEqualThan('4.0');

        if (available && !disabled) {
            try {
                const blocks = await loadWatcher.watchRequest(
                    CoreCoursesDashboard.getDashboardBlocksObservable({
                        myPage: supportsMyParam ? this.myPageCourses : undefined,
                        readingStrategy: loadWatcher.getReadingStrategy(),
                    }),
                );

                this.loadedBlock = blocks.mainBlocks.concat(blocks.sideBlocks).find((block) => block.name == 'myoverview');
                this.hasSideBlocks = supportsMyParam && CoreBlockDelegate.hasSupportedBlock(blocks.sideBlocks);

                await CoreWait.nextTicks(2);

                this.myOverviewBlock = this.block?.dynamicComponent?.instance as AddonBlockMyOverviewComponent;

                if (!this.loadedBlock && !supportsMyParam) {
                    this.loadFallbackBlock();
                }
            } catch (error) {
                CoreDomUtils.showErrorModal(error);
                this.loadFallbackBlock();
            }
        } else if (!available) {
            this.loadFallbackBlock();
        } else {
            this.loadedBlock = undefined;
        }

        this.loaded = true;
        this.onReadyPromise.resolve();
        this.logView();
    }

    protected loadFallbackBlock(): void {
        this.loadedBlock = {
            name: 'myoverview',
            visible: true,
        };
    }

    async refresh(refresher?: HTMLIonRefresherElement): Promise<void> {
        const promises: Promise<void>[] = [];

        promises.push(CoreCoursesDashboard.invalidateDashboardBlocks(CoreCoursesDashboardProvider.MY_PAGE_COURSES));

        if (this.myOverviewBlock) {
            promises.push(CoreUtils.ignoreErrors(this.myOverviewBlock.invalidateContent()));
        }

        Promise.all(promises).finally(() => {
            this.loadContent().finally(() => {
                refresher?.complete();
            });
        });
    }

    initHandlers(handlers: CoreMainMenuHomeHandlerToDisplay[]): void {
        const loaded = CoreMainMenuHomeDelegate.areHandlersLoaded();
        const handlersMap = CoreUtils.arrayToObject(handlers, 'title');
        const newTabs = handlers.map((handler): CoreTabsOutletTab => {
            const tab = this.tabs.find(tab => tab.title == handler.title);

            if (tab) {
                return tab;
            }

            return {
                page: `/main/${CoreMainMenuHomeHandlerService.PAGE_NAME}/${handler.page}`,
                pageParams: handler.pageParams,
                title: handler.title,
                class: handler.class,
                icon: handler.icon,
                badge: handler.badge,
            };
        });

        newTabs.sort((a, b) => (handlersMap[b.title].priority || 0) - (handlersMap[a.title].priority || 0));

        this.tabs = newTabs;

        setTimeout(() => {
            this.loaded = loaded;
        }, 50);
    }

    protected async loadSiteName(): Promise<void> {
        const site = CoreSites.getRequiredCurrentSite();
        this.siteName = await site.getSiteName() || '';
    }

    async openSearch(): Promise<void> {
        CoreNavigator.navigateToSitePath('/courses/list', { params: { mode: 'search' } });
    }

    async openNotifications(): Promise<void> {
        await CoreNavigator.navigateToSitePath('/notifications/list');
    }

    /**
     * Toggle layout value.
     *
     * @param layout New layout.
     * @returns Promise resolved when done.
     */
    async toggleLayout(layout: AddonBlockMyOverviewLayouts): Promise<void> {
        this.layout = layout;
        const site = CoreSites.getCurrentSite();
        if (site) {
            await site.setLocalSiteConfig('AddonBlockMyOverviewLayout', this.layout);
        }
    }

    async onToggleLayout(): Promise<void> {
        const newLayout = this.layout === 'card' ? 'list' : 'card';
        await this.toggleLayout(newLayout);
    }

    tabSelected(): void {
        this.deepLinkManager?.treatLink();
    }

    ionViewDidEnter(): void {
        this.tabsComponent?.ionViewDidEnter();
    }

    ionViewDidLeave(): void {
        this.tabsComponent?.ionViewDidLeave();
    }

    async ready(): Promise<void> {
        return await this.onReadyPromise;
    }

    ngOnDestroy(): void {
        this.updateSiteObserver?.off();
        this.loadsManagerSubscription.unsubscribe();
        this.subscription?.unsubscribe();
    }

}

type AddonBlockMyOverviewLayouts = 'card' | 'list';
