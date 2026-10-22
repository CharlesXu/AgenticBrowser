#include "chrome/browser/agentic_space_controls.h"
#include "chrome/browser/agentic_strings.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <memory>
#include <utility>

#include "base/check.h"
#include "base/functional/bind.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/scoped_observation.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/bind_post_task.h"
#include "base/timer/timer.h"
#include "cc/paint/paint_flags.h"
#include "cc/paint/paint_shader.h"
#include "chrome/browser/ui/views/frame/browser_view.h"
#include "chrome/browser/ui/views/frame/tab_strip_region_view.h"
#include "chrome/browser/ui/color/chrome_color_id.h"
#include "chrome/browser/ui/view_ids.h"
#include "components/viz/common/frame_sinks/copy_output_result.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/web_contents.h"
#include "ui/accessibility/ax_enums.mojom.h"
#include "ui/base/accelerators/accelerator.h"
#include "ui/base/metadata/metadata_impl_macros.h"
#include "ui/base/ui_base_types.h"
#include "ui/compositor/layer.h"
#include "ui/color/color_provider.h"
#include "ui/color/color_id.h"
#include "components/vector_icons/vector_icons.h"
#include "ui/base/models/image_model.h"
#include "ui/views/controls/button/image_button.h"
#include "ui/gfx/canvas.h"
#include "ui/gfx/color_utils.h"
#include "ui/base/resource/resource_bundle.h"
#include "ui/gfx/image/image_skia_operations.h"
#include "chrome/grit/theme_resources.h"
#include "ui/gfx/font_list.h"
#include "ui/gfx/geometry/insets.h"
#include "ui/gfx/image/image_skia.h"
#include "ui/gfx/geometry/vector2d.h"
#include "skia/ext/image_operations.h"
#include "third_party/skia/include/core/SkPath.h"
#include "ui/views/accessibility/view_accessibility.h"
#include "ui/views/accessible_pane_view.h"
#include "ui/views/background.h"
#include "ui/views/controls/button/button.h"
#include "ui/views/controls/button/md_text_button.h"
#include "ui/views/controls/label.h"
#include "ui/views/controls/scroll_view.h"
#include "ui/views/layout/box_layout.h"
#include "ui/views/focus/focus_manager.h"
#include "ui/views/view.h"
#include "ui/views/view_observer.h"
#include "ui/views/view_class_properties.h"
#include "ui/views/layout/flex_layout_types.h"
#include "ui/views/view_targeter.h"
#include "ui/views/view_targeter_delegate.h"
#include "ui/views/view_tracker.h"

namespace {
constexpr SkColor kBlue = SkColorSetRGB(42, 117, 234);
constexpr SkColor kGreen = SkColorSetRGB(22, 157, 103);
constexpr SkColor kRed = SkColorSetRGB(228, 66, 80);

// The same Portal mark identifies a workspace and the titlebar overview.
// Zero has no badge; the opaque badge remains legible in both color schemes.
void PaintSpaceIcon(gfx::Canvas* canvas, gfx::Point origin, int number,
                    SkColor ink, bool dark) {
  const auto* logo = ui::ResourceBundle::GetSharedInstance().GetImageSkiaNamed(
      IDR_AGENTIC_LOGO_MONO);
  const auto scaled = gfx::ImageSkiaOperations::CreateResizedImage(
      *logo, skia::ImageOperations::RESIZE_BEST, gfx::Size(20, 20));
  canvas->DrawImageInt(gfx::ImageSkiaOperations::CreateColorMask(scaled, ink),
                       origin.x(), origin.y());
  if (!number)
    return;
  const SkColor badge_ink = dark ? SK_ColorWHITE : SK_ColorBLACK;
  cc::PaintFlags flags;
  flags.setAntiAlias(true);
  flags.setColor(dark ? SK_ColorBLACK : SK_ColorWHITE);
  const gfx::Point center(origin.x() + 17, origin.y() + 16);
  canvas->DrawCircle(center, 6, flags);
  flags.setStyle(cc::PaintFlags::kStroke_Style);
  flags.setStrokeWidth(1);
  flags.setColor(badge_ink);
  canvas->DrawCircle(center, 6, flags);
  canvas->DrawStringRectWithFlags(
      number > 99 ? u"99+" : base::NumberToString16(number),
      gfx::FontList().DeriveWithSizeDelta(number > 9 ? -5 : -4), badge_ink,
      gfx::Rect(center.x() - 6, center.y() - 6, 12, 12),
      gfx::Canvas::TEXT_ALIGN_CENTER);
}

bool InputBlocked(const AgenticSpacePresentation& space) {
  return space.owner == AgenticSpaceOwner::kAgent ||
         space.owner == AgenticSpaceOwner::kAwaitingResume ||
         space.owner == AgenticSpaceOwner::kRemote;
}

bool HasGlow(const AgenticSpacePresentation& space) {
  return InputBlocked(space) || space.viewers > 0;
}

SkColor GlowColor(const AgenticSpacePresentation& space) {
  if (space.owner == AgenticSpaceOwner::kRemote)
    return kRed;
  return space.viewers > 0 ? kGreen : kBlue;
}

// The same edge treatment is used on the workspace and its overview card.
// It is browser-owned; no CSS or script is injected into websites.
void PaintAgentGlow(gfx::Canvas* canvas, gfx::Rect bounds, int depth,
                    SkColor color) {
  const gfx::Rect outer = bounds;
  const double phase = (base::TimeTicks::Now().since_origin().InMilliseconds() % 3600) *
                       (6.28318530718 / 3600.0);
  const float pulse = 0.86f + 0.14f * std::sin(phase);
  depth = static_cast<int>(depth * (0.94f + 0.06f * std::sin(phase)));
  cc::PaintFlags flags;
  const SkColor4f colors[] = {
      SkColor4f::FromColor(SkColorSetA(color, static_cast<int>(195 * pulse))),
      SkColor4f::FromColor(SkColorSetA(color, static_cast<int>(70 * pulse))),
      SkColor4f::FromColor(SkColorSetA(color, 0))};
  const SkScalar stops[] = {0, 0.4f, 1};
  auto paint_edge = [&](gfx::Rect area, SkPoint from, SkPoint to) {
    const SkPoint points[] = {from, to};
    flags.setShader(cc::PaintShader::MakeLinearGradient(
        points, colors, stops, 3, SkTileMode::kClamp));
    canvas->DrawRect(area, flags);
  };
  const float w = bounds.width(), h = bounds.height();
  const float left = bounds.x(), top = bounds.y();
  paint_edge(gfx::Rect(bounds.x(), bounds.y(), depth, h),
             {left, top}, {left + depth, top});
  paint_edge(gfx::Rect(bounds.right() - depth, bounds.y(), depth, h),
             {left + w, top}, {left + w - depth, top});
  paint_edge(gfx::Rect(bounds.x(), bounds.y(), w, depth),
             {left, top}, {left, top + depth});
  paint_edge(gfx::Rect(bounds.x(), bounds.bottom() - depth, w, depth),
             {left, top + h}, {left, top + h - depth});
  // The subtle dots stay at the edges, leaving the task itself readable.
  flags.setShader(nullptr);
  flags.setStyle(cc::PaintFlags::kFill_Style);
  flags.setAntiAlias(true);
  for (int y = outer.y() + 6; y < outer.bottom(); y += 12) {
    for (int x = outer.x() + 6; x < outer.right(); x += 12) {
      const int edge = std::min({x - outer.x(), outer.right() - x,
                                 y - outer.y(), outer.bottom() - y});
      if (edge < depth) {
        flags.setColor(SkColorSetA(SK_ColorWHITE, 95 * (depth - edge) / depth));
        canvas->DrawCircle(gfx::Point(x, y), 1, flags);
      }
    }
  }
}

class AgentGlow : public views::View, public views::ViewTargeterDelegate {
  METADATA_HEADER(AgentGlow, views::View)
 public:
  AgentGlow(views::View* controls, views::View* handoff)
      : controls_(controls), handoff_(handoff) {
    SetPaintToLayer();
    layer()->SetFillsBoundsOpaquely(false);
    SetEventTargeter(std::make_unique<views::ViewTargeter>(this));
    SetVisible(false);
  }
  void Update(const AgenticSpacePresentation& space) {
    color_ = GlowColor(space);
    blocking_ = InputBlocked(space);
    SchedulePaint();
  }
  bool DoesIntersectRect(const views::View* target,
                         const gfx::Rect& rect) const override {
    // A connected viewer changes the visual state, not local input ownership.
    if (!blocking_)
      return false;
    for (auto* allowed : {controls_.view(), handoff_.view()}) {
      if (allowed && allowed->GetVisible() &&
          views::View::ConvertRectToTarget(allowed, this,
                                          allowed->GetLocalBounds()).Intersects(rect))
        return false;
    }
    return views::ViewTargeterDelegate::DoesIntersectRect(target, rect);
  }
  bool OnMousePressed(const ui::MouseEvent&) override { return blocking_; }
  bool OnMouseWheel(const ui::MouseWheelEvent&) override { return blocking_; }
  void OnScrollEvent(ui::ScrollEvent* event) override {
    if (blocking_)
      event->SetHandled();
  }
  void OnGestureEvent(ui::GestureEvent* event) override {
    if (blocking_)
      event->SetHandled();
  }
  void OnPaint(gfx::Canvas* canvas) override {
    PaintAgentGlow(canvas, GetLocalBounds(),
                   std::clamp(std::min(width(), height()) / 6, 64, 160), color_);
  }
 private:
  views::ViewTracker controls_;
  views::ViewTracker handoff_;
  SkColor color_ = kBlue;
  bool blocking_ = false;
};
BEGIN_METADATA(AgentGlow)
END_METADATA

class WorkspaceCard : public views::Button {
  METADATA_HEADER(WorkspaceCard, views::Button)
 public:
  explicit WorkspaceCard(PressedCallback callback)
      : views::Button(std::move(callback)) {
    SetFocusBehavior(FocusBehavior::ALWAYS);
    SetRequestFocusOnPress(true);
    SetInstallFocusRingOnFocus(true);
  }

  void Update(const AgenticSpacePresentation& space, bool selected) {
    if (space.contents.get() != space_.contents.get()) {
      image_ = gfx::ImageSkia();
      captured_url_.clear();
    }
    space_ = space;
    selected_ = selected;
    SetAccessibleName(AgenticText("card", {space.name, space.status,
        base::NumberToString16(space.tabs.size())}));
    SetTooltipText(space.name + u" · " + space.status);
    SchedulePaint();
  }

  void Capture() {
    if (capturing_ || !space_.contents)
      return;
    auto* view = space_.contents->GetRenderWidgetHostView();
    if (!view || !view->IsSurfaceAvailableForCopy())
      return;
    capturing_ = true;
    const auto url = space_.contents->GetLastCommittedURL().spec();
    const auto size = view->GetViewBounds().size();
    const int height = size.width() > 0
                           ? std::max(1, 640 * size.height() / size.width())
                           : 400;
    view->CopyFromSurface(
        gfx::Rect(), gfx::Size(640, height), base::Milliseconds(800),
        base::BindPostTaskToCurrentDefault(base::BindOnce(
            &WorkspaceCard::Captured, weak_.GetWeakPtr(), space_.contents,
            url)));
  }

 private:
  void Captured(base::WeakPtr<content::WebContents> contents,
                std::string url,
                const content::CopyFromSurfaceResult& result) {
    capturing_ = false;
    if (!contents || contents.get() != space_.contents.get() ||
        contents->GetLastCommittedURL().spec() != url)
      return;
    if (result.has_value() && !result->bitmap.drawsNothing()) {
      image_ = gfx::ImageSkia::CreateFrom1xBitmap(result->bitmap);
      captured_url_ = std::move(url);
      SchedulePaint();
    }
  }

  void PaintButtonContents(gfx::Canvas* canvas) override {
    const auto font = gfx::FontList();
    const auto small = font.DeriveWithSizeDelta(-1);
    const auto* colors = GetColorProvider();
    const SkColor background = colors->GetColor(kColorToolbar);
    const SkColor ink = colors->GetColor(kColorToolbarText);
    const SkColor muted = SkColorSetA(ink, 180);
    const bool dark = color_utils::IsDark(background);
    gfx::Rect frame(5, 5, width() - 10, height() - 64);
    if (frame.IsEmpty())
      return;
    canvas->Save();
    canvas->ClipPath(SkPath::RRect(SkRect::MakeXYWH(
        frame.x(), frame.y(), frame.width(), frame.height()), 12, 12), true);
    canvas->FillRect(frame, background);

    // Render the entire workspace at one scale. Browser metadata and the
    // compositor page are composed locally; never capture the OS desktop.
    const int source_width = std::max(640, workspace_size_.width());
    const int source_height = std::max(400, workspace_size_.height());
    canvas->Translate(gfx::Vector2d(frame.x(), frame.y()));
    canvas->Scale(static_cast<float>(frame.width()) / source_width,
                   static_cast<float>(frame.height()) / source_height);
    canvas->FillRect(gfx::Rect(0, 0, source_width, 80),
                     colors->GetColor(kColorTabBackgroundInactiveFrameActive));
    const int count = static_cast<int>(space_.tabs.size());
    const int shown = std::min(count, std::max(1, (source_width - 90) / 140));
    // Keep the selected tab in view even when the Space has many tabs.
    const int first = std::max(0, space_.selected_tab - shown + 1);
    const int tab_width = std::min(220, (source_width - 90) / std::max(1, shown));
    for (int i = 0; i < shown; ++i) {
      gfx::Rect tab(12 + i * tab_width, 5, tab_width - 4, 30);
      if (first + i == space_.selected_tab)
        canvas->FillRect(tab, background);
      tab.Inset(gfx::Insets::VH(0, 10));
      canvas->DrawStringRect(space_.tabs[first + i], font, ink, tab);
    }
    canvas->DrawStringRect(u"+", font, muted,
                           gfx::Rect(16 + shown * tab_width, 5, 30, 30));
    canvas->DrawStringRect(u"‹   ›   ↻", font, muted, gfx::Rect(12, 43, 82, 26));
    const gfx::Rect address(104, 43, source_width - 172, 27);
    canvas->FillRect(address, background);
    if (space_.contents) {
      gfx::Rect text = address;
      text.Inset(gfx::Insets::VH(0, 10));
      canvas->DrawStringRect(
          base::UTF8ToUTF16(space_.contents->GetLastCommittedURL().spec()),
          font, muted, text);
    }
    canvas->DrawStringRect(u"⋯", font, muted,
                           gfx::Rect(source_width - 50, 43, 30, 27));
    gfx::Rect page(0, 80, source_width, source_height - 80);
    const bool current_image = space_.contents && !image_.isNull() &&
        captured_url_ == space_.contents->GetLastCommittedURL().spec();
    if (current_image) {
      const float scale = std::min(static_cast<float>(page.width()) / image_.width(),
                                   static_cast<float>(page.height()) / image_.height());
      const int w = image_.width() * scale;
      const int h = image_.height() * scale;
      canvas->DrawImageInt(image_, 0, 0, image_.width(), image_.height(),
                           page.x() + (page.width() - w) / 2, page.y(), w, h, true);
    } else {
      canvas->DrawStringRect(AgenticText("waiting_frame"), font, muted, page);
    }
    if (HasGlow(space_))
      PaintAgentGlow(canvas, gfx::Rect(source_width, source_height),
                     std::clamp(source_height / 6, 64, 160), GlowColor(space_));
    canvas->Restore();

    cc::PaintFlags border;
    border.setStyle(cc::PaintFlags::kStroke_Style);
    border.setAntiAlias(true);
    border.setStrokeWidth(selected_ || HasFocus() ? 3 : 1);
    border.setColor(selected_ || HasFocus() ? GlowColor(space_)
                                           : SkColorSetA(ink, 65));
    canvas->DrawRoundRect(frame, 12, border);
    PaintSpaceIcon(canvas, gfx::Point(8, height() - 51), space_.number, ink, dark);
    if (space_.number == 0)
      canvas->DrawStringRect(AgenticText("main"), font, ink,
                             gfx::Rect(36, height() - 53, width() - 93, 24));
    canvas->DrawStringRect(AgenticText("pages", {base::NumberToString16(count)}), small, muted,
                           gfx::Rect(width() - 52, height() - 53, 48, 24));
    canvas->DrawStringRect(space_.status, small,
                           HasGlow(space_) ? GlowColor(space_) : muted,
                           gfx::Rect(8, height() - 29, width() - 16, 22));
  }

 public:
  void SetWorkspaceSize(gfx::Size size) { workspace_size_ = size; }

 private:
  gfx::Size workspace_size_;

  AgenticSpacePresentation space_;
  gfx::ImageSkia image_;
  std::string captured_url_;
  bool selected_ = false;
  bool capturing_ = false;
  base::WeakPtrFactory<WorkspaceCard> weak_{this};
};
BEGIN_METADATA(WorkspaceCard)
END_METADATA

class SpaceOverview : public views::AccessiblePaneView {
  METADATA_HEADER(SpaceOverview, views::AccessiblePaneView)
 public:
  SpaceOverview(base::RepeatingCallback<void(int)> select,
                base::RepeatingCallback<void(int)> remove,
                base::RepeatingClosure create, base::RepeatingClosure close)
      : select_(std::move(select)), remove_(std::move(remove)),
        close_(std::move(close)) {
    SetPaintToLayer();
    layer()->SetFillsBoundsOpaquely(true);
    SetBackground(views::CreateSolidBackground(kColorToolbar));
    GetViewAccessibility().SetRole(ax::mojom::Role::kGroup);
    SetAccessibleName(AgenticText("overview"));
    title_ = AddChildView(std::make_unique<views::Label>());
    hint_ = AddChildView(std::make_unique<views::Label>(
        AgenticText("legend")));
    keyboard_hint_ = AddChildView(std::make_unique<views::Label>(
        AgenticText("shortcuts")));
    close_button_ = AddChildView(std::make_unique<views::ImageButton>(close_));
    close_button_->SetImageModel(views::Button::STATE_NORMAL,
        ui::ImageModel::FromVectorIcon(vector_icons::kArrowBackIcon,
                                      kColorToolbarButtonIcon, 20));
    close_button_->SetAccessibleName(AgenticText("back"));
    close_button_->SetTooltipText(AgenticText("back"));
    close_button_->SetFocusBehavior(FocusBehavior::ALWAYS);
    close_button_->SetImageHorizontalAlignment(views::ImageButton::ALIGN_CENTER);
    close_button_->SetImageVerticalAlignment(views::ImageButton::ALIGN_MIDDLE);
    close_button_->SetBackground(views::CreateRoundedRectBackground(
        ui::kColorSysSurfaceVariant, 18));
    scroll_ = AddChildView(std::make_unique<views::ScrollView>());
    scroll_->SetBackgroundColor(kColorToolbar);
    grid_ = scroll_->SetContents(std::make_unique<views::View>());
    create_button_ = grid_->AddChildView(std::make_unique<views::MdTextButton>(
        std::move(create), AgenticText("create")));
    create_button_->SetCornerRadius(12);
    SetVisible(false);
  }

  void Update(int selected, const std::vector<AgenticSpacePresentation>& spaces) {
    selected_ = selected;
    std::vector<int> ids;
    for (const auto& space : spaces)
      ids.push_back(space.id);
    if (ids != ids_) {
      for (auto* card : cards_)
        grid_->RemoveChildViewT(card);
      for (auto* button : remove_buttons_)
        grid_->RemoveChildViewT(button);
      cards_.clear();
      remove_buttons_.clear();
      ids_ = std::move(ids);
      for (int id : ids_) {
        cards_.push_back(grid_->AddChildView(std::make_unique<WorkspaceCard>(
            base::BindRepeating(select_, id))));
        auto* button = grid_->AddChildView(std::make_unique<views::MdTextButton>(
            base::BindRepeating(remove_, id), u"×"));
        button->SetCustomPadding(gfx::Insets());
        button->SetCornerRadius(15);
        remove_buttons_.push_back(button);
      }
      focused_ = 0;
      OnBoundsChanged(gfx::Rect());
    }
    title_->SetText(AgenticText("count", {base::NumberToString16(spaces.size() - 1)}));
    for (size_t i = 0; i < cards_.size(); ++i) {
      cards_[i]->Update(spaces[i], spaces[i].id == selected);
      remove_buttons_[i]->SetVisible(spaces[i].id != 0);
      remove_buttons_[i]->SetEnabled(spaces[i].can_close);
      remove_buttons_[i]->SetAccessibleName(AgenticText("close", {spaces[i].name}));
      remove_buttons_[i]->SetTooltipText(spaces[i].can_close
          ? AgenticText("close_tip") : AgenticText("close_busy"));
    }
  }
  void Show() {
    SetVisible(true);
    auto found = std::ranges::find(ids_, selected_);
    focused_ = found == ids_.end() ? 0 : std::distance(ids_.begin(), found);
    SetPaneFocus(cards_[focused_]);
    Capture();
    refresh_.Start(FROM_HERE, base::Seconds(1), this, &SpaceOverview::Capture);
  }
  void Hide() {
    refresh_.Stop();
    SetVisible(false);
  }
  void Next(int direction) {
    const int count = cards_.size();
    focused_ = (focused_ + direction + count) % count;
    cards_[focused_]->RequestFocus();
    cards_[focused_]->ScrollRectToVisible(cards_[focused_]->GetLocalBounds());
  }
  int focused() const { return ids_[focused_]; }
  void Animate() {
    for (auto* card : cards_)
      card->SchedulePaint();
  }
  void OnDidChangeFocus(views::View* before, views::View* now) override {
    views::AccessiblePaneView::OnDidChangeFocus(before, now);
    if (GetVisible() && now && !Contains(now) && !cards_.empty())
      SetPaneFocus(cards_[focused_]);
    for (size_t i = 0; i < cards_.size(); ++i)
      if (now == cards_[i])
        focused_ = static_cast<int>(i);
  }
  bool AcceleratorPressed(const ui::Accelerator& event) override {
    if (event.key_code() == ui::VKEY_ESCAPE) {
      close_.Run();
      return true;
    }
    return views::AccessiblePaneView::AcceleratorPressed(event);
  }
  bool OnMousePressed(const ui::MouseEvent&) override { return true; }
  bool OnMouseWheel(const ui::MouseWheelEvent&) override { return true; }
  void OnScrollEvent(ui::ScrollEvent* event) override { event->SetHandled(); }
  void OnGestureEvent(ui::GestureEvent* event) override { event->SetHandled(); }
  void OnBoundsChanged(const gfx::Rect&) override {
    // Keep clickable controls below Chromium's native draggable tab strip.
    title_->SetBounds(width() / 2 - 90, 56, 180, 32);
    close_button_->SetBounds(width() - 60, 54, 36, 36);
    hint_->SetBounds(24, 94, width() - 48, 24);
    keyboard_hint_->SetBounds(24, height() - 44, width() - 48, 28);
    scroll_->SetBounds(24, 138, std::max(1, width() - 48), std::max(1, height() - 192));
    const int gap = 26;
    const int columns = std::clamp((width() - 48) / 320, 1, 3);
    const int card_width = (width() - 72 - gap * (columns - 1)) / columns;
    const float ratio = static_cast<float>(std::max(1, height())) / std::max(1, width());
    const int card_height = std::max(170, static_cast<int>((card_width - 10) * ratio) + 64);
    for (size_t i = 0; i <= cards_.size(); ++i) {
      const int x = (i % columns) * (card_width + gap);
      const int y = (i / columns) * (card_height + gap);
      if (i == cards_.size()) {
        create_button_->SetBounds(x + 5, y + 5, card_width - 10, card_height - 64);
      } else {
        cards_[i]->SetWorkspaceSize(size());
        cards_[i]->SetBounds(x, y, card_width, card_height);
        remove_buttons_[i]->SetBounds(x + card_width - 48, y + 12, 36, 30);
      }
    }
    const int rows = (cards_.size() + 1 + columns - 1) / columns;
    grid_->SetPreferredSize(gfx::Size(width() - 72, rows * (card_height + gap)));
  }

 private:
  void Capture() {
    for (auto* card : cards_)
      card->Capture();
  }
  base::RepeatingCallback<void(int)> select_;
  base::RepeatingCallback<void(int)> remove_;
  base::RepeatingClosure close_;
  raw_ptr<views::Label> title_ = nullptr;
  raw_ptr<views::Label> hint_ = nullptr;
  raw_ptr<views::Label> keyboard_hint_ = nullptr;
  raw_ptr<views::ImageButton> close_button_ = nullptr;
  raw_ptr<views::ScrollView> scroll_ = nullptr;
  raw_ptr<views::View> grid_ = nullptr;
  raw_ptr<views::MdTextButton> create_button_ = nullptr;
  std::vector<WorkspaceCard*> cards_;
  std::vector<views::MdTextButton*> remove_buttons_;
  std::vector<int> ids_;
  int selected_ = 0;
  int focused_ = 0;
  base::RepeatingTimer refresh_;
};
BEGIN_METADATA(SpaceOverview)
END_METADATA

class HandoffBar : public views::View {
  METADATA_HEADER(HandoffBar, views::View)
 public:
  explicit HandoffBar(AgenticSpaceAction action) : action_(std::move(action)) {
    SetPaintToLayer();
    layer()->SetFillsBoundsOpaquely(false);
    SetBackground(views::CreateRoundedRectBackground(
        SkColorSetARGB(242, 35, 43, 57), 18));
    GetViewAccessibility().SetRole(ax::mojom::Role::kGroup);
    SetAccessibleName(AgenticText("ownership"));
    name_ = AddChildView(std::make_unique<views::Label>());
    status_ = AddChildView(std::make_unique<views::Label>());
    for (auto* label : {name_.get(), status_.get()}) {
      label->SetHorizontalAlignment(gfx::ALIGN_LEFT);
      label->SetAutoColorReadabilityEnabled(false);
      label->SetBackgroundColor(SK_ColorTRANSPARENT);
    }
    name_->SetEnabledColor(SK_ColorWHITE);
    button_ = AddChildView(std::make_unique<views::MdTextButton>(
        base::BindRepeating(&HandoffBar::Act, base::Unretained(this)), AgenticText("take")));
    SetVisible(false);
  }
  void Update(const AgenticSpacePresentation& space) {
    name_->SetText(space.name);
    const bool human = space.owner == AgenticSpaceOwner::kHuman;
    const bool remote = space.owner == AgenticSpaceOwner::kRemote;
    const bool waiting = space.owner == AgenticSpaceOwner::kAwaitingResume;
    status_->SetText(space.status);
    status_->SetEnabledColor(remote ? SkColorSetRGB(255, 160, 169)
                            : human || space.viewers > 0
                                ? SkColorSetRGB(155, 225, 190)
                                : SkColorSetRGB(143, 190, 255));
    command_ = human ? AgenticSpaceCommand::kReturn : AgenticSpaceCommand::kTake;
    button_->SetText(human ? AgenticText("return")
                    : remote ? AgenticText("local_take") : AgenticText("take"));
    button_->SetTooltipText(human ? AgenticText("return_tip")
                            : remote ? AgenticText("local_take_tip")
                                  : AgenticText("take_tip"));
    button_->SetVisible(human ? space.can_return : InputBlocked(space));
    if (waiting && space.viewers == 0)
      status_->SetEnabledColor(SkColorSetRGB(255, 210, 132));
    OnBoundsChanged(gfx::Rect());
  }
  void OnBoundsChanged(const gfx::Rect&) override {
    const int text_width = width() - (button_->GetVisible() ? 176 : 48);
    name_->SetBounds(24, 12, text_width, 23);
    status_->SetBounds(24, 36, text_width, 23);
    button_->SetBounds(width() - 148, 19, 128, 36);
  }
 private:
  void Act() { action_.Run(command_, -1); }
  AgenticSpaceAction action_;
  AgenticSpaceCommand command_ = AgenticSpaceCommand::kTake;
  raw_ptr<views::Label> name_ = nullptr;
  raw_ptr<views::Label> status_ = nullptr;
  raw_ptr<views::MdTextButton> button_ = nullptr;
};
BEGIN_METADATA(HandoffBar)
END_METADATA

class SpaceOverviewButton : public views::Button {
  METADATA_HEADER(SpaceOverviewButton, views::Button)
 public:
  explicit SpaceOverviewButton(PressedCallback callback)
      : views::Button(std::move(callback)) {
    SetPreferredSize(gfx::Size(42, 30));
    SetFocusBehavior(FocusBehavior::ALWAYS);
    SetRequestFocusOnPress(true);
    SetInstallFocusRingOnFocus(false);
  }
  void Update(int selected,
              const std::vector<AgenticSpacePresentation>& spaces) {
    const auto shown = std::ranges::find(spaces, selected, &AgenticSpacePresentation::id);
    count_ = std::ranges::count_if(spaces, [](const auto& space) {
      return space.id != 0;
    });
    int agents = 0, viewers = 0, remote = 0;
    std::u16string details;
    for (const auto& space : spaces) {
      if (space.id == 0)
        continue;
      agents += space.owner == AgenticSpaceOwner::kAgent;
      viewers += space.viewers > 0 && space.owner != AgenticSpaceOwner::kRemote;
      remote += space.owner == AgenticSpaceOwner::kRemote;
      details += u"\n" + space.name + u"：" + space.status;
    }
    active_ = {agents > 0, viewers > 0, remote > 0};
    const auto summary = AgenticText("summary", {base::NumberToString16(count_),
        base::NumberToString16(agents), base::NumberToString16(viewers),
        base::NumberToString16(remote)});
    SetAccessibleName(AgenticText("open_state", {summary, shown->name, shown->status}));
    SetTooltipText(summary + AgenticText("dots") + details + u"\n" + AgenticText("open_tip"));
    SchedulePaint();
  }
 private:
  void PaintButtonContents(gfx::Canvas* canvas) override {
    const SkColor ink = GetColorProvider()->GetColor(kColorTabForegroundInactiveFrameActive);
    cc::PaintFlags flags;
    flags.setAntiAlias(true);
    if (GetState() == STATE_HOVERED || GetState() == STATE_PRESSED) {
      flags.setColor(SkColorSetA(ink, GetState() == STATE_PRESSED ? 32 : 18));
      canvas->DrawRoundRect(gfx::RectF(GetLocalBounds()), 8, flags);
    }
    flags.setColor(ink);
    flags.setStyle(cc::PaintFlags::kStroke_Style);
    flags.setStrokeWidth(1.5f);
    const int middle = height() / 2;
    PaintSpaceIcon(canvas, gfx::Point(4, middle - 10), count_, ink,
        color_utils::IsDark(GetColorProvider()->GetColor(kColorToolbar)));
    flags.setStyle(cc::PaintFlags::kFill_Style);
    const std::array<SkColor, 3> colors = {kBlue, kGreen, kRed};
    for (size_t i = 0; i < active_.size(); ++i) {
      flags.setColor(active_[i] ? colors[i] : SkColorSetA(ink, 45));
      canvas->DrawCircle(gfx::Point(30, middle - 6 + static_cast<int>(i) * 6),
                         2, flags);
    }
  }
  int count_ = 2;
  std::array<bool, 3> active_{};
};
BEGIN_METADATA(SpaceOverviewButton)
END_METADATA

class AgenticSpaceControls : public views::View, public views::ViewObserver {
  METADATA_HEADER(AgenticSpaceControls, views::View)
 public:
  explicit AgenticSpaceControls(AgenticSpaceAction action)
      : action_(std::move(action)) {
    GetViewAccessibility().SetRole(ax::mojom::Role::kGroup);
    SetAccessibleName(AgenticText("controls"));
    SetLayoutManager(std::make_unique<views::BoxLayout>(
        views::BoxLayout::Orientation::kHorizontal, gfx::Insets(), 6));
    overview_button_ = AddChildView(std::make_unique<SpaceOverviewButton>(
        base::BindRepeating(&AgenticSpaceControls::ToggleOverview,
                            weak_.GetWeakPtr())));
    overview_button_->SetAccessibleName(AgenticText("open"));
    overview_button_->SetTooltipText(AgenticText("open_tip"));
    AddAccelerator(ui::Accelerator(ui::VKEY_ESCAPE, ui::EF_NONE));
  }
  void Attach(BrowserView* browser_view) {
    browser_view_ = browser_view;
    observation_.Observe(browser_view);
    handoff_ = browser_view->AddChildView(std::make_unique<HandoffBar>(action_));
    glow_ = browser_view->AddChildView(std::make_unique<AgentGlow>(this, handoff_));
    overview_ = browser_view->AddChildView(std::make_unique<SpaceOverview>(
        base::BindRepeating(&AgenticSpaceControls::SelectSpace,
                            weak_.GetWeakPtr()),
        base::BindRepeating(&AgenticSpaceControls::RemoveSpace, weak_.GetWeakPtr()),
        base::BindRepeating(&AgenticSpaceControls::CreateSpace, weak_.GetWeakPtr()),
        base::BindRepeating(&AgenticSpaceControls::CloseOverview,
                            weak_.GetWeakPtr())));
    OnViewBoundsChanged(browser_view);
    // Observation blocks renderer input, so workspace switching must run
    // before the focused page can consume the key.
    GetFocusManager()->RegisterAccelerator(
        ui::Accelerator(ui::VKEY_S, ui::EF_ALT_DOWN),
        ui::AcceleratorManager::kHighPriority, this);
    // Keep common browser shortcuts from editing the workspace behind the
    // overview / observation overlay. Main Space retains normal shortcuts.
    for (auto key : {ui::VKEY_L, ui::VKEY_T, ui::VKEY_W, ui::VKEY_R})
      for (int flags : {ui::EF_COMMAND_DOWN, ui::EF_CONTROL_DOWN})
        GetFocusManager()->RegisterAccelerator(
            ui::Accelerator(key, flags),
            ui::AcceleratorManager::kHighPriority, this);
    for (auto key : {ui::VKEY_LEFT, ui::VKEY_RIGHT, ui::VKEY_RETURN})
      AddAccelerator(ui::Accelerator(key, ui::EF_NONE));
  }
  AgenticSpaceUpdate GetUpdateCallback() {
    return base::BindRepeating(&AgenticSpaceControls::Update,
                               weak_.GetWeakPtr());
  }
  void OnViewBoundsChanged(views::View* view) override {
    if (glow_ && overview_) {
      glow_->SetBoundsRect(view->GetLocalBounds());
      overview_->SetBoundsRect(view->GetLocalBounds());
      const int bar_width = std::min(480, std::max(300, view->width() - 40));
      handoff_->SetBounds((view->width() - bar_width) / 2,
                          std::max(0, view->height() - 96), bar_width, 74);
    }
  }
  void OnViewHierarchyWillBeDeleted(views::View*) override {
    animation_.Stop();
    observation_.Reset();
    browser_view_ = nullptr;
    glow_ = nullptr;
    handoff_ = nullptr;
    overview_ = nullptr;
  }
  bool AcceleratorPressed(const ui::Accelerator& accelerator) override {
    if (accelerator.key_code() == ui::VKEY_S) {
      if (overview_ && overview_->GetVisible())
        overview_->Next(1);
      else
        ToggleOverview();
      return true;
    }
    if (overview_ && overview_->GetVisible()) {
      switch (accelerator.key_code()) {
        case ui::VKEY_ESCAPE: CloseOverview(); break;
        case ui::VKEY_LEFT: overview_->Next(-1); break;
        case ui::VKEY_RIGHT: overview_->Next(1); break;
        case ui::VKEY_RETURN: SelectSpace(overview_->focused()); break;
        default: break;
      }
      return true;
    }
    return observing_ && (accelerator.key_code() == ui::VKEY_L ||
                          accelerator.key_code() == ui::VKEY_T ||
                          accelerator.key_code() == ui::VKEY_W ||
                          accelerator.key_code() == ui::VKEY_R);
  }
 private:
  void ToggleOverview() {
    if (!overview_)
      return;
    if (overview_->GetVisible()) {
      CloseOverview();
    } else {
      handoff_->SetVisible(false);
      browser_view_->ReorderChildView(overview_, browser_view_->children().size() - 1);
      overview_->Show();
    }
    UpdateAnimation();
  }
  void CloseOverview() {
    if (!overview_)
      return;
    overview_->Hide();
    handoff_->SetVisible(selected_ != 0);
    browser_view_->ReorderChildView(handoff_, browser_view_->children().size() - 1);
    overview_button_->RequestFocus();
    UpdateAnimation();
  }
  void SelectSpace(int selected) {
    CloseOverview();
    action_.Run(AgenticSpaceCommand::kSelect, selected);  // Observation only.
  }
  void CreateSpace() {
    CloseOverview();
    action_.Run(AgenticSpaceCommand::kCreate, -1);
  }
  void RemoveSpace(int id) {
    action_.Run(AgenticSpaceCommand::kClose, id);
  }
  void Update(int selected,
              const std::vector<AgenticSpacePresentation>& spaces) {
    const auto& space = *std::ranges::find(spaces, selected, &AgenticSpacePresentation::id);
    selected_ = selected;
    observing_ = selected != 0 && InputBlocked(space);
    glowing_ = selected != 0 && HasGlow(space);
    any_glow_ = std::ranges::any_of(spaces, HasGlow);
    overview_button_->Update(selected, spaces);
    handoff_->Update(space);
    handoff_->SetVisible(selected != 0 && !overview_->GetVisible());
    if (glow_) {
      glow_->Update(space);
      glow_->SetVisible(glowing_);
      if (!overview_->GetVisible())
        browser_view_->ReorderChildView(glow_, browser_view_->children().size() - 1);
      browser_view_->ReorderChildView(handoff_, browser_view_->children().size() - 1);
    }
    if (overview_)
      overview_->Update(selected, spaces);
    UpdateAnimation();
  }
  void UpdateAnimation() {
    if (!overview_ || !(overview_->GetVisible() ? any_glow_ : glowing_)) {
      animation_.Stop();
    } else if (!animation_.IsRunning()) {
      animation_.Start(FROM_HERE, base::Milliseconds(80), this,
                       &AgenticSpaceControls::Animate);
    }
  }
  void Animate() {
    if (overview_->GetVisible())
      overview_->Animate();
    else
      glow_->SchedulePaint();
  }

  const AgenticSpaceAction action_;
  raw_ptr<BrowserView> browser_view_ = nullptr;
  raw_ptr<AgentGlow> glow_ = nullptr;
  raw_ptr<SpaceOverview> overview_ = nullptr;
  raw_ptr<HandoffBar> handoff_ = nullptr;
  raw_ptr<SpaceOverviewButton> overview_button_ = nullptr;
  int selected_ = 0;
  bool observing_ = false;
  bool glowing_ = false;
  bool any_glow_ = false;
  base::RepeatingTimer animation_;
  base::ScopedObservation<views::View, views::ViewObserver> observation_{this};
  base::WeakPtrFactory<AgenticSpaceControls> weak_{this};
};
BEGIN_METADATA(AgenticSpaceControls)
END_METADATA

}  // namespace

AgenticSpaceUpdate AddAgenticSpaceControls(BrowserWindowInterface* browser,
                                          AgenticSpaceAction action) {
  CHECK(browser);
  CHECK(action);
  auto* browser_view = BrowserView::GetBrowserViewForBrowser(browser);
  CHECK(browser_view);
  auto* titlebar = browser_view->tab_strip_view();
  CHECK(titlebar);
  auto* controls = titlebar->AddChildView(
      std::make_unique<AgenticSpaceControls>(std::move(action)));
  controls->SetProperty(views::kCrossAxisAlignmentKey,
                        views::LayoutAlignment::kCenter);
  controls->SetProperty(views::kMarginsKey, gfx::Insets::TLBR(0, 0, 0, 14));
  controls->Attach(browser_view);
  return controls->GetUpdateCallback();
}
